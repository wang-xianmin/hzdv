/**
 * GET /api/passkey/qr/poll?sid=xxx
 * 桌面端轮询（建议 1.5~2s）：返回 pending / ready / success / expired / unknown。
 * ready 表示手机已验证成功、等待桌面用户确认；只回掩码账号，不回 user_key 明文。
 */

import { passkeyEnabled } from "../../../lib/passkey-config.js";
import { pickD1 } from "../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured } from "../../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../../lib/passkey-rate.js";
import { findQrSession, isQrSessionId, maskUserKey } from "../../../lib/passkey-qr.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const url = new URL(request.url);
  const sid = String(url.searchParams.get("sid") || "").trim();
  const unknown = { ok: true, status: "unknown", poll_interval_ms: 1500 };
  if (!isQrSessionId(sid)) return jsonResponse(unknown);

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-poll:" + sid + ":" + clientBucketId(request), {
    limit: 60,
    windowMs: 60000,
  });
  if (!ok) return jsonResponse({ ...unknown, status: "pending" });

  try {
    const row = await findQrSession(d1, sid);
    if (!row) return jsonResponse(unknown);
    const expiresAt = Number(row.expires_at) || 0;
    if (Date.now() > expiresAt) {
      return jsonResponse({ ok: true, status: "expired", expires_at: expiresAt, poll_interval_ms: 1500 });
    }
    if (String(row.status) === "success") {
      const delivered = !row.session_token;
      return jsonResponse({
        ok: true,
        status: delivered ? "success" : "ready",
        delivered,
        user: delivered ? undefined : { userKeyMasked: maskUserKey(row.user_key) },
        expires_at: expiresAt,
        poll_interval_ms: 1500,
      });
    }
    return jsonResponse({ ok: true, status: "pending", expires_at: expiresAt, poll_interval_ms: 1500 });
  } catch (e) {
    console.error("[passkey/qr/poll]", e);
    return jsonResponse(unknown);
  }
}
