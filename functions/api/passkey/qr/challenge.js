/**
 * POST /api/passkey/qr/challenge?sid=xxx
 * 手机落地页请求 WebAuthn 认证选项：生成一次性 challenge 并绑定到该 QR 会话。
 */

import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { passkeyEnabled, isAllowedOrigin } from "../../../lib/passkey-config.js";
import { pickD1 } from "../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../lib/passkey-resp.js";
import { rateLimit } from "../../../lib/passkey-rate.js";
import { findQrSession, setQrChallenge, isQrSessionId } from "../../../lib/passkey-qr.js";
import { randomBase64Url, sha256Hex } from "../../../lib/passkey-crypto.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const url = new URL(request.url);
  const sid = String(url.searchParams.get("sid") || "").trim();
  if (!isQrSessionId(sid)) return fail(400);

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const ok = await rateLimit(env, "qr-challenge:" + sid, { limit: 10, windowMs: 60000 });
  if (!ok) return fail(429);

  try {
    const row = await findQrSession(d1, sid);
    if (!row || String(row.status) !== "pending") return fail(404);
    if (Date.now() > Number(row.expires_at)) return fail(410);
    // 同源校验：落地页必须与发起端同源，且在白名单内
    const origin = url.origin;
    if (origin !== String(row.origin || "")) return fail(403);
    if (!isAllowedOrigin(env, origin)) return fail(403);

    const challenge = randomBase64Url(32);
    const challengeHash = await sha256Hex(challenge);
    const bound = await setQrChallenge(d1, sid, { challengeHash, challengePlain: challenge });
    if (!bound) return fail(409);

    const opts = await generateAuthenticationOptions({
      rpID: String(row.rp_id || ""),
      challenge,
      allowCredentials: [],
      userVerification: "preferred",
      timeout: 60000,
    });
    // 显式下发 canonical challenge，保证与 D1 中 challenge_hash 一致
    opts.challenge = challenge;
    // 手机本机就是 client-device；提示浏览器优先本机认证器
    opts.hints = ["client-device"];

    return jsonResponse({ ok: true, publicKey: opts });
  } catch (e) {
    console.error("[passkey/qr/challenge]", e);
    return fail(503);
  }
}
