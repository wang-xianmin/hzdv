/**
 * POST /api/passkey/qr/verify
 * 手机落地页提交 WebAuthn assertion：服务端校验后按 credential_id 反查 user_key，
 * 并签发【一次性交接用】的会话令牌（明文暂存 qr 会话行，由桌面 claim 取走一次）。
 *
 * 重要：手机端拿不到任何 token/会话；会话只在桌面端 claim 后生效。
 */

import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { passkeyEnabled, isAllowedOrigin, sessionTtlMs } from "../../../lib/passkey-config.js";
import { pickD1, findActiveCredentialById } from "../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../lib/passkey-resp.js";
import { rateLimit } from "../../../lib/passkey-rate.js";
import {
  findQrSession,
  completeQrSession,
  rollbackQrSession,
  isQrSessionId,
} from "../../../lib/passkey-qr.js";
import {
  bytesFromBase64Url,
  stringFromBytes,
  sha256Hex,
  timingSafeEqualHex,
  parseAuthDataFlags,
  randomBase64Url,
} from "../../../lib/passkey-crypto.js";

/** 统一模糊失败（不泄露凭据/账号存在性）。 */
function authFail(status) {
  return fail(status);
}

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

  const sessionId = String(body.session_id || body.sid || "").trim();
  if (!isQrSessionId(sessionId)) return fail(400);

  const ok = await rateLimit(env, "qr-verify:" + sessionId, { limit: 10, windowMs: 60000 });
  if (!ok) return fail(429);

  const credential = body && body.credential ? body.credential : null;
  if (!credential || !credential.response) return fail(400);

  try {
    const row = await findQrSession(d1, sessionId);
    if (!row || String(row.status) !== "pending") return authFail(400);
    if (Date.now() > Number(row.expires_at)) return authFail(400);
    if (!row.challenge_hash || !row.challenge_plain) return authFail(400);

    // --- clientDataJSON 校验 ---
    let clientData;
    try {
      clientData = JSON.parse(stringFromBytes(bytesFromBase64Url(credential.response.clientDataJSON)));
    } catch {
      return authFail(400);
    }
    if (!clientData || clientData.type !== "webauthn.get") return authFail(400);
    const cdChallenge = String(clientData.challenge || "");
    const cdOrigin = String(clientData.origin || "");
    if (!isAllowedOrigin(env, cdOrigin)) return authFail(400);
    if (cdOrigin !== String(row.origin || "")) return authFail(400);
    const challengeHash = await sha256Hex(cdChallenge);
    if (!timingSafeEqualHex(challengeHash, String(row.challenge_hash))) {
      return authFail(400);
    }

    // --- authenticatorData flags ---
    let authData = null;
    try {
      authData = bytesFromBase64Url(credential.response.authenticatorData);
      if (authData.length < 37) authData = null;
    } catch {
      authData = null;
    }
    if (!authData) return authFail(400);
    const flags = parseAuthDataFlags(authData);
    if (!flags || !flags.up) return authFail(400);
    if ((flags.be ? 1 : 0) === 0 && (flags.bs ? 1 : 0) === 1) return authFail(400);

    // --- credentialId 服务端绝对映射 ---
    const credentialId = String(credential.id || "");
    if (!credentialId) return authFail(400);
    const cred = await findActiveCredentialById(d1, credentialId);
    if (!cred) return authFail(401);
    if ((flags.be ? 1 : 0) !== (cred.backup_eligible ? 1 : 0)) return authFail(401);

    let publicKey;
    try {
      publicKey = bytesFromBase64Url(cred.public_key_cose);
    } catch {
      return authFail(401);
    }

    const storedCounter = Number(cred.sign_count) || 0;
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: String(row.challenge_plain),
      expectedOrigin: cdOrigin,
      expectedRPID: String(row.rp_id || ""),
      credential: {
        id: credentialId,
        publicKey,
        counter: storedCounter,
      },
      requireUserVerification: false,
    });
    if (!verification || verification.verified !== true) return authFail(401);

    const ai = (verification && verification.authenticationInfo) || {};
    const newCounter = Number(ai.newCounter) || 0;
    if (storedCounter > 0 && newCounter <= storedCounter) return authFail(401);

    // --- 签发会话（明文一次性交接给桌面；hash 落 auth_sessions）---
    const sessionToken = randomBase64Url(32);
    const sessionTokenHash = await sha256Hex(sessionToken);
    const result = await completeQrSession(d1, {
      sessionId,
      credentialId,
      storedSignCount: storedCounter,
      newSignCount: newCounter,
      backedUp: flags.bs,
      userVerified: flags.uv,
      userKey: String(cred.user_key),
      userUuid: cred.user_uuid ? String(cred.user_uuid) : "",
      sessionToken,
      sessionTokenHash,
      sessionTtlMs: sessionTtlMs(env),
    });

    if (!result.credentialUpdated) return authFail(409);
    if (!result.sessionCompleted || !result.sessionInserted) {
      await rollbackQrSession(d1, { sessionId, sessionTokenHash });
      return authFail(409);
    }

    // 手机端不返回 token/会话
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("[passkey/qr/verify]", e);
    return authFail(503);
  }
}
