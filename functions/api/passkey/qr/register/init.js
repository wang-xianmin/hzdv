/**
 * POST /api/passkey/qr/register/init
 *
 * 桌面端发起扫码注册：当前登录身份在服务端解析后写入 QR 会话；
 * 手机端只能凭 sid 继续 ceremony，不提供也不被信任任何 user_key / phone。
 */

import { passkeyEnabled, rpId, isAllowedOrigin } from "../../../../lib/passkey-config.js";
import { pickD1 } from "../../../../lib/passkey-d1.js";
import { resolveIdentity } from "../../../../lib/passkey-auth.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  unauthorized,
  fail,
} from "../../../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../../../lib/passkey-rate.js";
import {
  insertQrRegisterSession,
  qrTtlMs,
  cleanupExpiredQrSessions,
} from "../../../../lib/passkey-qr.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-register-init:" + clientBucketId(request), {
    limit: 10,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  const origin = new URL(request.url).origin;
  if (!isAllowedOrigin(env, origin)) return fail(403);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const identity = await resolveIdentity(env, d1, request, body);
  if (!identity) return unauthorized();
  if (!identity.userKey) return unauthorized();

  const sessionId = crypto.randomUUID();
  try {
    await cleanupExpiredQrSessions(d1);
    const row = await insertQrRegisterSession(d1, {
      sessionId,
      rpId: rpId(env),
      origin,
      userKey: identity.userKey,
      userUuid: identity.userUuid || "",
      ttlMs: qrTtlMs(env),
    });
    return jsonResponse({
      ok: true,
      session_id: sessionId,
      qr_url: origin + "/passkey/register-scan?sid=" + encodeURIComponent(sessionId),
      expires_at: row.expiresAt,
      poll_interval_ms: 1500,
    });
  } catch (e) {
    console.error("[passkey/qr/register/init]", e);
    return fail(503);
  }
}
