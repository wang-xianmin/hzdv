/**
 * POST /api/passkey/qr/register/options?sid=xxx
 *
 * 手机端请求创建通行密钥的 WebAuthn options。身份只来自扫码会话
 * （桌面发起时预写入的 user_key / user_uuid），不读取请求体里的 phone/uuid。
 */

import { generateRegistrationOptions } from "@simplewebauthn/server";
import { passkeyEnabled, rpId, rpName, isAllowedOrigin } from "../../../../lib/passkey-config.js";
import { pickD1, findUserActiveCredentials } from "../../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../../lib/passkey-resp.js";
import { rateLimit } from "../../../../lib/passkey-rate.js";
import { findQrRegisterSession, isQrSessionId } from "../../../../lib/passkey-qr.js";
import { randomBase64Url, sha256Hex } from "../../../../lib/passkey-crypto.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const url = new URL(request.url);
  const sid = String(url.searchParams.get("sid") || "").trim();
  if (!isQrSessionId(sid)) return fail(400);

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-register-options:" + sid, { limit: 10, windowMs: 60000 });
  if (!ok) return fail(429);

  try {
    const row = await findQrRegisterSession(d1, sid);
    if (!row || String(row.status) !== "pending") return fail(404);
    if (Date.now() > Number(row.expires_at)) return fail(410);

    const origin = url.origin;
    if (origin !== String(row.origin || "")) return fail(403);
    if (!isAllowedOrigin(env, origin)) return fail(403);

    const userKey = String(row.user_key || "");
    const userUuid = String(row.user_uuid || "");
    if (!userKey) return fail(403);

    const existing = await findUserActiveCredentials(d1, userKey);
    const excludeCredentials = existing
      .filter((c) => c && c.credential_id)
      .map((c) => ({ type: "public-key", id: c.credential_id }));

    const challenge = randomBase64Url(32);
    const challengeHash = await sha256Hex(challenge);
    const userHandle = new TextEncoder().encode(userUuid ? userUuid : "u:" + userKey);

    const opts = await generateRegistrationOptions({
      rpName: rpName(env),
      rpID: String(row.rp_id || rpId(env)),
      userID: userHandle,
      userName: "user",
      userDisplayName: "user",
      attestationType: "none",
      timeout: 60000,
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: "preferred",
      },
      excludeCredentials,
    });
    opts.challenge = challenge;

    // 复用 QR 会话的 challenge_hash/challenge_plain 字段保存一次性注册 challenge。
    // 只有 flow=register 且仍 pending 的会话可以绑定，避免登录/注册流程串线。
    const bound = await d1
      .prepare(
        `UPDATE passkey_qr_sessions
            SET challenge_hash = ?, challenge_plain = ?
          WHERE session_id = ? AND flow = 'register' AND status = 'pending' AND expires_at > ?`
      )
      .bind(challengeHash, challenge, sid, Date.now())
      .run();
    if (!(Number(bound && bound.meta ? bound.meta.changes : 0) > 0)) return fail(409);

    return jsonResponse({ ok: true, publicKey: opts });
  } catch (e) {
    console.error("[passkey/qr/register/options]", e);
    return fail(503);
  }
}
