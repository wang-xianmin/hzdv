/**
 * POST /api/passkey/qr/init
 * 桌面端初始化 QR 登录会话：生成 UUIDv4 session_id，写 D1 passkey_qr_sessions，
 * 返回同源落地页 URL（绝不把 sid 发给第三方 QR 服务）。
 */

import { passkeyEnabled, rpId, isAllowedOrigin } from "../../../lib/passkey-config.js";
import { pickD1 } from "../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../../lib/passkey-rate.js";
import { insertQrSession, qrTtlMs, cleanupExpiredQrSessions } from "../../../lib/passkey-qr.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-init:" + clientBucketId(request), {
    limit: 10,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  const origin = new URL(request.url).origin;
  if (!isAllowedOrigin(env, origin)) return fail(403);

  const sessionId = crypto.randomUUID();
  try {
    await cleanupExpiredQrSessions(d1);
    const row = await insertQrSession(d1, {
      sessionId,
      rpId: rpId(env),
      origin,
      ttlMs: qrTtlMs(env),
    });
    return jsonResponse({
      ok: true,
      session_id: sessionId,
      qr_url: origin + "/passkey/scan?sid=" + encodeURIComponent(sessionId),
      expires_at: row.expiresAt,
      poll_interval_ms: 1500,
    });
  } catch (e) {
    // 表未迁移（preview 需先跑 0006）时优雅降级，不 500
    console.error("[passkey/qr/init]", e);
    return fail(503);
  }
}
