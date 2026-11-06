/**
 * POST /api/passkey/reauth
 * 为已用密码/邮箱登录的用户取得 5 分钟一次性 reauth 票据，用于绑定 passkey。
 *
 * body:
 *   { method: "password", phone, password }
 *   { method: "email",    phone, email, code }
 *
 * 密码分支复用现有 $kdf-sha256$ 校验；邮箱分支必须校验一次性验证码（不能只凭
 * phone+email 相同就发票据）。成功后返回 reauthToken 并设置 HttpOnly 票据 cookie。
 * 票据 = HMAC 签名 + nonce 记 D1，保证一次性。
 */

import { passkeyEnabled, reauthTtlMs } from "../../lib/passkey-config.js";
import { pickD1 } from "../../lib/passkey-d1.js";
import { pickKvBinding } from "../../lib/kv-binding.js";
import {
  readKvUser,
  assertPhoneKey,
  verifyPasswordArgon2idEncodedFlexible,
} from "../../lib/kv-secure.js";
import { normalizePasswordForAuth } from "../../lib/password-normalize.js";
import {
  issueReauthTicket,
  verifyEmailReauthCode,
  normalizeEmail,
} from "../../lib/passkey-auth.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  unauthorized,
  fail,
} from "../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../lib/passkey-rate.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  let body = {};
  try {
    body = await request.json();
  } catch {
    return fail(400);
  }

  const ok = await rateLimit(env, "reauth:" + clientBucketId(request), {
    limit: 10,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  const method = String(body.method || "").trim();
  if (method !== "password" && method !== "email") return fail(400);

  const phone = String(body.phone || "").trim();
  if (!phone) return fail(400);
  const key = "phone:" + phone.replace(/\D/g, "");
  try {
    assertPhoneKey(key);
  } catch {
    return fail(400);
  }

  try {
    let userKey = key;
    let userUuid = "";

    if (method === "password") {
      const kv = pickKvBinding(env);
      if (!kv) return notConfigured();
      const password = body.password != null ? String(body.password) : "";
      if (!password) return fail(400);
      const row = await readKvUser(kv, env, key);
      if (!row || !row.value) return unauthorized();

      const value = row.value;
      const pwdHash = value.pwd_hash != null ? String(value.pwd_hash) : "";
      const pwdRaw = value.pwd != null ? String(value.pwd) : "";
      let verified = false;
      if (pwdHash) {
        verified = await verifyPasswordArgon2idEncodedFlexible(password, pwdHash);
      } else if (pwdRaw && pwdRaw.charAt(0) === "$") {
        verified = await verifyPasswordArgon2idEncodedFlexible(password, pwdRaw);
      } else if (pwdRaw !== "") {
        verified =
          normalizePasswordForAuth(pwdRaw) === normalizePasswordForAuth(password);
      }
      if (!verified) return unauthorized();
      userKey = key;
      userUuid = value.uuid != null ? String(value.uuid) : "";
    } else {
      // email 分支：必须消费有效的一次性邮箱码
      const email = String(body.email || "").trim();
      const code = String(body.code || "").trim();
      if (!email || !code) return fail(400);
      const granted = await verifyEmailReauthCode(d1, { email, code });
      if (!granted) return unauthorized();
      // 交叉核对：票据绑定的账号邮箱 == 请求邮箱
      const kv = pickKvBinding(env);
      if (kv) {
        const row = await readKvUser(kv, env, key).catch(() => null);
        if (row && row.value) {
          const stored = normalizeEmail(row.value.email);
          if (stored && stored !== normalizeEmail(email)) return unauthorized();
          userUuid = row.value.uuid != null ? String(row.value.uuid) : "";
        }
      }
      userKey = granted.userKey || key;
    }

    const ticket = await issueReauthTicket(env, d1, {
      userKey,
      userUuid,
      mfaLevel: 1,
    });

    const isSecure = new URL(request.url).protocol === "https:";
    const cookieName = isSecure ? "__Host-pk_reauth" : "pk_reauth";
    const cookieValue = `${cookieName}=${encodeURIComponent(ticket.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.round(reauthTtlMs(env) / 1000))}${isSecure ? "; Secure" : ""}`;

    return jsonResponse(
      {
        ok: true,
        expiresAt: ticket.expiresAt,
        reauthToken: ticket.token,
      },
      200,
      { "Set-Cookie": cookieValue }
    );
  } catch (e) {
    console.error("[passkey/reauth]", e);
    return fail(500);
  }
}