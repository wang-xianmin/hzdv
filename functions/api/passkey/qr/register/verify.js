/**
 * POST /api/passkey/qr/register/verify?sid=xxx
 *
 * 手机端提交 WebAuthn attestation。服务端验证 challenge/origin/RP ID 后，
 * 将 credential 绑定到扫码会话预写入的账号，并把会话置 success。
 */

import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeCredentialPublicKey, decodeAttestationObject } from "@simplewebauthn/server/helpers";
import { passkeyEnabled, isAllowedOrigin } from "../../../../lib/passkey-config.js";
import { pickD1, completeQrRegisterSession } from "../../../../lib/passkey-d1.js";
import { jsonResponse, methodNotAllowed, disabled, notConfigured, fail } from "../../../../lib/passkey-resp.js";
import { rateLimit } from "../../../../lib/passkey-rate.js";
import { findQrRegisterSession, isQrSessionId } from "../../../../lib/passkey-qr.js";
import {
  bytesFromBase64Url,
  base64UrlFromBytes,
  stringFromBytes,
  sha256Hex,
  timingSafeEqualHex,
  parseAuthDataFlags,
  extractAuthDataFromAttestationObject,
} from "../../../../lib/passkey-crypto.js";

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

  const url = new URL(request.url);
  const sid = String(body.session_id || body.sid || url.searchParams.get("sid") || "").trim();
  if (!isQrSessionId(sid)) return fail(400);

  const ok = await rateLimit(env, "qr-register-verify:" + sid, { limit: 10, windowMs: 60000 });
  if (!ok) return fail(429);

  const credential = body && body.credential ? body.credential : null;
  if (!credential || !credential.response) return fail(400);

  try {
    const row = await findQrRegisterSession(d1, sid);
    if (!row || String(row.status) !== "pending") return fail(400);
    if (Date.now() > Number(row.expires_at)) return fail(400);
    if (!row.challenge_hash || !row.challenge_plain) return fail(400);

    let clientData;
    try {
      clientData = JSON.parse(stringFromBytes(bytesFromBase64Url(credential.response.clientDataJSON)));
    } catch {
      return fail(400);
    }
    if (!clientData || clientData.type !== "webauthn.create") return fail(400);
    const cdChallenge = String(clientData.challenge || "");
    const cdOrigin = String(clientData.origin || "");
    if (!isAllowedOrigin(env, cdOrigin)) return fail(400);
    if (cdOrigin !== String(row.origin || "")) return fail(400);
    const challengeHash = await sha256Hex(cdChallenge);
    if (!timingSafeEqualHex(challengeHash, String(row.challenge_hash))) return fail(400);

    let authData = null;
    if (credential.response.authenticatorData) {
      try {
        authData = bytesFromBase64Url(credential.response.authenticatorData);
        if (authData.length < 37) authData = null;
      } catch {
        authData = null;
      }
    }
    if (!authData) {
      let attObjBytes = null;
      try {
        attObjBytes = bytesFromBase64Url(credential.response.attestationObject);
      } catch {
        attObjBytes = null;
      }
      if (attObjBytes) {
        try {
          const decoded = decodeAttestationObject(attObjBytes);
          const a = decoded && decoded.get("authData");
          if (a) authData = a instanceof Uint8Array ? a : new Uint8Array(a);
        } catch (e) {
          console.error("[passkey/qr/register/verify] decodeAttestationObject err", e);
        }
        if (!authData) authData = extractAuthDataFromAttestationObject(attObjBytes);
      }
    }
    if (!authData || authData.length < 37) return fail(400);
    const flags = parseAuthDataFlags(authData);
    if (!flags || !flags.up) return fail(400);
    if (flags.be === 0 && flags.bs === 1) return fail(400);

    const expectedRPID = String(row.rp_id || "");
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: String(row.challenge_plain),
      expectedOrigin: cdOrigin,
      expectedRPID,
      requireUserVerification: false,
    });
    if (!verification || verification.verified !== true) return fail(401);

    const reg = (verification && verification.registrationInfo) || {};
    const credentialId = (reg.credential && reg.credential.id) || String(credential.id || "");
    if (!credentialId) return fail(400);

    let publicKeyBytes = null;
    let algorithm = 0;
    if (reg.credential && reg.credential.publicKey) {
      publicKeyBytes = reg.credential.publicKey;
    } else if (reg.credentialPublicKey) {
      publicKeyBytes = reg.credentialPublicKey;
    }
    if (publicKeyBytes) {
      if (!(publicKeyBytes instanceof Uint8Array)) {
        publicKeyBytes = new Uint8Array(publicKeyBytes);
      }
      try {
        const coseMap = decodeCredentialPublicKey(publicKeyBytes) || new Map();
        algorithm = Number(coseMap.get(3)) || 0;
      } catch (e) {
        console.error("[passkey/qr/register/verify] cose decode", e);
      }
    }
    if (!publicKeyBytes) return fail(400);

    const transports = Array.isArray(credential.response.transports)
      ? credential.response.transports.filter((t) => typeof t === "string")
      : [];

    const result = await completeQrRegisterSession(d1, {
      sessionId: sid,
      credential: {
        credentialId,
        publicKeyCose: base64UrlFromBytes(publicKeyBytes),
        algorithm,
        signCount: Number(reg.counter) || 0,
        transports,
        aaguid: reg.aaguid ? String(reg.aaguid) : "00000000-0000-0000-0000-000000000000",
        backupEligible: flags.be,
        backedUp: flags.bs,
        userVerified: flags.uv,
        attestationFormat: "none",
        attestationType: "none",
        credentialDeviceType: reg.credentialDeviceType ? String(reg.credentialDeviceType) : "",
        rpId: expectedRPID,
        origin: cdOrigin,
        label: String(body.label || "扫码注册").slice(0, 80),
      },
    });
    if (!result.inserted || !result.completed) return fail(409);

    return jsonResponse({ ok: true, credential: { id: credentialId } });
  } catch (e) {
    console.error("[passkey/qr/register/verify]", e);
    return fail(503);
  }
}
