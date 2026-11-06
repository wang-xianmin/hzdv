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
    return jsonResponse({
      ok: true,
      sessionToken: claimed.sessionToken,
      user: {
        userKey: claimed.userKey,
        userUuid: claimed.userUuid,
      },
    });
  } catch (e) {
    console.error("[passkey/qr/claim]", e);
    return fail(503);
  }
}
