/**
 * POST /api/passkey/qr/claim?sid=xxx
 * 桌面端在用户确认后取走一次性 sessionToken（明文只交付一次，服务端立即清空）。
 * 桌面拿到后必须 auth.setSessionCookie(token)，才是真会话；不允许只靠 user_key 假装登录。
 */

import { passkeyEnabled } from "../../../lib/passkey-config.js";
import { pickD1 } from "../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../../lib/passkey-rate.js";
import { claimQrSession, isQrSessionId } from "../../../lib/passkey-qr.js";
import { pickKvBinding } from "../../../lib/kv-binding.js";
import { readKvUser } from "../../../lib/kv-secure.js";
import { roleOf } from "../../../lib/auth-roles.js";

function emptyProfileProjection() {
  return { stored_username: "", stored_email: "", user_data: {} };
}

function phoneFromClaimedUserKey(userKey) {
  const match = /^(?:phone:)?(\d{6,20})$/.exec(String(userKey || ""));
  return match ? match[1] : "";
}

/**
 * 从 KV 读取已认领账号的资料，并只投影个人资料页需要的白名单字段。
 * claim 的一次性 sessionToken 已被消费，因此这里必须 best-effort：读取失败
 * 返回空投影，不能让整个登录在客户端无法重试 claim 的情况下失败。
 */
async function hydrateClaimedUser(env, claimed) {
  const phone = phoneFromClaimedUserKey(claimed && claimed.userKey);
  if (!phone) return emptyProfileProjection();

  const kv = pickKvBinding(env);
  if (!kv) return emptyProfileProjection();

  try {
    const row = await readKvUser(kv, env, "phone:" + phone);
    if (!row || !row.value) return emptyProfileProjection();

    const value = row.value;
    const role = roleOf(row);
    const rawWxu = String(value.wxu || "");
    // 不返回完整 openid/wxu；短值也不完整暴露，仅展示至少 9 位时的前 8 位。
    const wxuPrefix = rawWxu.length > 8 ? rawWxu.slice(0, 8) : "";
    return {
      stored_username: value.name != null ? String(value.name) : "",
      stored_email: value.email != null ? String(value.email) : "",
      user_data: {
        other_data: value.uuid != null ? String(value.uuid) : "",
        pwd: "",
        avatar_url: value.avatar_url != null ? String(value.avatar_url) : "",
        avatar_r2_key: value.avatar_r2_key != null ? String(value.avatar_r2_key) : "",
        avatar_data_url: value.avatar_data_url != null ? String(value.avatar_data_url) : "",
        type: role.typeMask,
        group: value.group != null ? String(value.group) : "",
        g_role: Number(value.g_role) === 1 ? 1 : 0,
        wxu_prefix: wxuPrefix,
      },
    };
  } catch (e) {
    console.error("[passkey/qr/claim] KV profile hydrate failed", e);
    return emptyProfileProjection();
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const url = new URL(request.url);
  const sid = String(url.searchParams.get("sid") || "").trim();
  if (!isQrSessionId(sid)) return fail(409);

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-claim:" + sid + ":" + clientBucketId(request), {
    limit: 20,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  try {
    const claimed = await claimQrSession(d1, sid);
    if (!claimed.ok) return fail(409);
    const profile = await hydrateClaimedUser(env, claimed);
    return jsonResponse({
      ok: true,
      sessionToken: claimed.sessionToken,
      user: {
        userKey: claimed.userKey,
        userUuid: claimed.userUuid,
        stored_username: profile.stored_username,
        stored_email: profile.stored_email,
        user_data: profile.user_data,
      },
    });
  } catch (e) {
    console.error("[passkey/qr/claim]", e);
    return fail(503);
  }
}
