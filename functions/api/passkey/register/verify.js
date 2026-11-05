/**
 * POST /api/passkey/register/verify
 * 验证 attestation 并新增一条 credential（D1 权威，一次性消费）。
 * 需要与 options 相同的服务端身份；ceremonyId 必须属于当前 user_key。
 *
 * 安全校验（与 hard_rules 逐条对齐）：
 *  - clientDataJSON.type == 'webauthn.create'
 *  - challenge 一致（用 SHA-256 比较，D1 不存原 challenge）
 *  - origin 在显式白名单
 *  - authenticatorData.rpIdHash == SHA256(rpId)；UP=true；UV 落库但不强制
 *  - BE/BS 组合合法（BE=0 且 BS=1 拒绝）
 *  - credential_id UNIQUE；与用户绝对映射，不采信客户端 user id
 *  - 验签成功后原子消费 ceremony；重复提交同一 challenge 被拒
 */

import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeCredentialPublicKey, decodeAttestationObject } from "@simplewebauthn/server/helpers";
import { passkeyEnabled, isAllowedOrigin } from "../../../lib/passkey-config.js";
import {
  pickD1,
  getChallenge,
  consumeAndInsertCredential,
} from "../../../lib/passkey-d1.js";
import { resolveIdentity } from "../../../lib/passkey-auth.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  unauthorized,
  fail,
} from "../../../lib/passkey-resp.js";
import {
  bytesFromBase64Url,
  base64UrlFromBytes,
  stringFromBytes,
  sha256Hex,
  timingSafeEqualHex,
  parseAuthDataFlags,
  extractAuthDataFromAttestationObject,
} from "../../../lib/passkey-crypto.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const trace = env && env.PASSKEY_DEBUG_TRACE === "1";
  const reject = (stage, code = 400) => {
    if (trace) console.error("[verify] reject@" + stage);
    return fail(code);
  };

  let body = {};
  try {
    body = await request.json();
  } catch {
    return reject("parse_body");
  }

  const identity = await resolveIdentity(env, d1, request, body);
  if (!identity) return unauthorized();

  const ceremonyId = String(body.ceremonyId || "");
  const credential = body && body.credential ? body.credential : null;
  if (!ceremonyId || !credential || !credential.response) return reject("payload");

  try {
    const row = await getChallenge(d1, ceremonyId);
    if (!row) return reject("no_challenge", 404);
    if (Date.now() > Number(row.expires_at)) return reject("expired");
    if (String(row.user_key) !== identity.userKey) return reject("user_mismatch");

    // --- clientDataJSON 校验 ---
    let clientData;
    let clientDataBytes;
    try {
      clientDataBytes = bytesFromBase64Url(credential.response.clientDataJSON);
      clientData = JSON.parse(stringFromBytes(clientDataBytes));
    } catch {
      return reject("cdj_parse");
    }
    if (!clientData || clientData.type !== "webauthn.create") return reject("cdj_type");
    const cdChallenge = String(clientData.challenge || "");
    const cdOrigin = String(clientData.origin || "");
    if (!isAllowedOrigin(env, cdOrigin)) return reject("origin_whitelist");
    const expectedChallengeHash = await sha256Hex(cdChallenge);
    if (!timingSafeEqualHex(expectedChallengeHash, String(row.challenge_hash))) {
      return reject("challenge_hash");
    }

    // --- authenticatorData flags（注册响应从 attestationObject 提取）---
    let authData;
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
          if (trace) console.error("[verify] decodeAttestationObject err", e);
        }
        if (!authData) authData = extractAuthDataFromAttestationObject(attObjBytes);
      }
    }
    if (!authData || authData.length < 37) return reject("authdata_missing");
    const flags = parseAuthDataFlags(authData);
    if (!flags) return reject("authdata_flags");
    if (!flags.up) return reject("up_false");
    if (flags.be === 0 && flags.bs === 1) return reject("be0_bs1");
    const backupEligible = flags.be;
    const backedUp = flags.bs;
    const userVerified = flags.uv;

    // --- SimpleWebAuthn 验签 ---
    const expectedRPID = String(row.rp_id);
    const verification = await verifyRegistrationResponse({
      response: credential, // v14 期望完整 PublicKeyCredential（含 id、rawId、type、response）
      expectedChallenge: cdChallenge,
      expectedOrigin: cdOrigin,
      expectedRPID,
    });
    if (!verification || verification.verified !== true) return reject("verify_lib_false");
    const reg = (verification && verification.registrationInfo) || {};

    const credentialId =
      (reg.credential && reg.credential.id) || String(credential.id || "");
    if (!credentialId) return reject("no_cred_id");

    let publicKeyBytes = null;
    let algorithm = 0;
    if (reg.credentialPublicKey) {
      publicKeyBytes =
        reg.credentialPublicKey instanceof Uint8Array
          ? reg.credentialPublicKey
          : new Uint8Array(reg.credentialPublicKey);
      try {
        const coseMap = decodeCredentialPublicKey(publicKeyBytes) || new Map();
        algorithm = Number(coseMap.get(3)) || 0;
      } catch (e) {
        console.error("[passkey/register/verify] cose decode", e);
      }
    }
    if (!publicKeyBytes) return reject("no_pubkey");

    const transports = Array.isArray(credential.response.transports)
      ? credential.response.transports.filter((t) => typeof t === "string")
      : [];

    const result = await consumeAndInsertCredential(d1, ceremonyId, {
      userKey: identity.userKey,
      userUuid: identity.userUuid || "",
      credentialId,
      publicKeyCose: base64UrlFromBytes(publicKeyBytes),
      algorithm,
      signCount: Number(reg.counter) || 0,
      transports,
      aaguid: reg.aaguid ? String(reg.aaguid) : "00000000-0000-0000-0000-000000000000",
      backupEligible,
      backedUp,
      userVerified,
      attestationFormat: "none",
      attestationType: "none",
      credentialDeviceType: reg.credentialDeviceType ? String(reg.credentialDeviceType) : "",
      rpId: expectedRPID,
      origin: cdOrigin,
      label: String(body.label || "").slice(0, 80),
    });

    if (!result.inserted || !result.consumed) {
      return reject("consume_or_insert", 409);
    }

    if (trace) {
      console.error(
        "[verify] ok credentialId=" + credentialId + " algorithm=" + algorithm +
          " up=" + flags.up + " uv=" + userVerified + " be=" + backupEligible + " bs=" + backedUp
      );
    }
    return jsonResponse({
      ok: true,
      credential: {
        id: credentialId,
        name: String(body.label || "").slice(0, 80),
        createdAt: Date.now(),
        backedUp,
        backupEligible,
        deviceType: reg.credentialDeviceType ? String(reg.credentialDeviceType) : "unknown",
        algorithm,
      },
    });
  } catch (e) {
    console.error("[passkey/register/verify]", e);
    return reject("exception");
  }
}