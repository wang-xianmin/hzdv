/**
 * GET /api/passkey/qr/register/poll?sid=xxx
 *
 * 桌面端轮询扫码注册结果。只返回状态，不返回账号标识或凭据内容。
 */

import { passkeyEnabled } from "../../../../lib/passkey-config.js";
import { pickD1 } from "../../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured } from "../../../../lib/passkey-resp.js";
import { rateLimit, clientBucketId } from "../../../../lib/passkey-rate.js";
import { findQrRegisterSession, isQrSessionId } from "../../../../lib/passkey-qr.js";

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

  const ok = await rateLimit(env, "qr-register-poll:" + sid + ":" + clientBucketId(request), {
    limit: 60,
    windowMs: 60000,
  });
  if (!ok) return jsonResponse({ ...unknown, status: "pending" });

  try {
    const row = await findQrRegisterSession(d1, sid);
    if (!row) return jsonResponse(unknown);
    const expiresAt = Number(row.expires_at) || 0;
    if (Date.now() > expiresAt) {
      return jsonResponse({ ok: true, status: "expired", expires_at: expiresAt, poll_interval_ms: 1500 });
    }
    if (String(row.status) === "success") {
      return jsonResponse({ ok: true, status: "success", expires_at: expiresAt, poll_interval_ms: 1500 });
    }
    return jsonResponse({ ok: true, status: "pending", expires_at: expiresAt, poll_interval_ms: 1500 });
  } catch (e) {
    console.error("[passkey/qr/register/poll]", e);
    return jsonResponse(unknown);
  }
}
