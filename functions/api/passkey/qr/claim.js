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
import { issueSiteAuthToken, buildClearMfaCookie } from "../../../lib/auth-token.js";

function emptyProfileProjection() {
  return { stored_username: "", stored_email: "", auth: null, user_data: {} };
}

function phoneFromClaimedUserKey(userKey) {
  const match = /^(?:phone:)?(\d{6,20})$/.exec(String(userKey || ""));
  return match ? match[1] : "";
}

/**
 * 从 KV 读取已认领账号的资料，并只投影个人资料页需要的白名单字段。
 * claim 的一次性 sessionToken 已被消费，因此这里必须 best-effort：读取失败
 * 返回空投影，不能让整个登录在客户端无法重试 claim 的情况下失败。
 *
 * 同时带出签发站点令牌所需的 auth 上下文（phone / tv / isSuper）。
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
      auth: {
        phone,
        tv: Number(value.tv || 0),
        isSuper: !!role.isSuper,
      },
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

    // 通行密钥单通道：除 passkey 会话外，同时签发站点令牌 hz_auth，
    // 否则登录后站点接口（个人资料/运维）会因缺 hz_auth 而 401。
    // 超管必须带 mfa=true（requireAuth 对超管强制要求），否则表现为「登录成功但接口 401」。
    // best-effort：签发失败不影响 passkey 会话本身。
    const cookies = [];
    const authCtx = profile.auth;
    if (authCtx && authCtx.phone) {
      try {
        const issued = await issueSiteAuthToken(env, authCtx.phone, {
          tv: authCtx.tv,
          isSuper: authCtx.isSuper,
        });
        cookies.push(issued.cookie);
        // 半程凭证 600s 内不被消费：单通道登录成功后清掉，避免旧半程被跨会话复用
        cookies.push(buildClearMfaCookie());
      } catch (authErr) {
        console.error("[passkey/qr/claim] issue site auth token failed:", authErr.message);
      }
    }

    const resp = jsonResponse({
      ok: true,
      sessionToken: claimed.sessionToken,
      user: {
        userKey: claimed.userKey,
        userUuid: claimed.userUuid,
        stored_username: profile.stored_username,
        stored_email: profile.stored_email,
        user_data: profile.user_data,
      },
    }, 200);
    // 必须逐个 append：Headers/Response 结构体里传数组会被拼成一条逗号连起来的 Set-Cookie，
    // 浏览器只会当作单个 cookie 解析，导致后一个 cookie 丢失（对齐 wx-login-poll 的写法）。
    for (const c of cookies) resp.headers.append("Set-Cookie", c);
    return resp;
  } catch (e) {
    console.error("[passkey/qr/claim]", e);
    return fail(503);
  }
}
