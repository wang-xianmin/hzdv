/**
 * POST /api/passkey/authenticate/verify
 * 验证 assertion、原子消费 challenge、CAS 更新 signCount 并创建 auth_session。
 *
 * 身份绝不信任客户端 user id / phone / uuid：一律服务端按 credentialId 反查绝对映射。
 * credetialId 未知或签名失败 → 返回完全相同的模糊响应（防枚举；status/body 一致）。
 *
 * 安全校验（hard_rules）：clientDataJSON.type=='webauthn.get'、challenge 一致、
 * origin 白名单、rpIdHash==SHA256(rpId)、UP=true、status='active'、
 * BE=0/BS=1 拒绝；signCount=0 跳过递增、>0 必须严格递增（库内 + CAS 双重校验）；
 * 成功后一次性消费 challenge + CAS 更新 + 建 session（D1 batch 原子）。
 */

import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import {
  passkeyEnabled,
  rpId,
  isAllowedOrigin,
  sessionTtlMs,
} from "../../../lib/passkey-config.js";
import {
  pickD1,
  getChallenge,
  findActiveCredentialById,
  loginAtomic,
} from "../../../lib/passkey-d1.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  fail,
  VAGUE_FAIL,
} from "../../../lib/passkey-resp.js";
import {
  bytesFromBase64Url,
  stringFromBytes,
  sha256Hex,
  timingSafeEqualHex,
  parseAuthDataFlags,
  randomBase64Url,
} from "../../../lib/passkey-crypto.js";
import { rateLimit, clientBucketId } from "../../../lib/passkey-rate.js";

/** 未知 credentialId 与签名失败共用的同一模糊响应（防枚举）。 */
function authFail(status, env, stage) {
  if (env && env.PASSKEY_DEBUG_TRACE === "1") console.error("[authn/verify] reject@" + stage);
  return jsonResponse({ ok: false, error: VAGUE_FAIL }, status);
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

  const ok = await rateLimit(env, "authn-verify:" + clientBucketId(request), {
    limit: 20,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  const ceremonyId = String(body.ceremonyId || "");
  const credential = body && body.credential ? body.credential : null;
  if (!ceremonyId || !credential || !credential.response) return fail(400);

  try {
    const row = await getChallenge(d1, ceremonyId);
    if (!row) return authFail(400, env, "no_challenge"); // 一次性消费 / 未知 ceremony
    if (Date.now() > Number(row.expires_at)) return authFail(400, env, "expired");

    // --- clientDataJSON 校验 ---
    let clientData;
    let clientDataBytes;
    try {
      clientDataBytes = bytesFromBase64Url(credential.response.clientDataJSON);
      clientData = JSON.parse(stringFromBytes(clientDataBytes));
    } catch {
      return authFail(400, env, "cdj_parse");
    }
    if (!clientData || clientData.type !== "webauthn.get") return authFail(400, env, "cdj_type");
    const cdChallenge = String(clientData.challenge || "");
    const cdOrigin = String(clientData.origin || "");
    if (!isAllowedOrigin(env, cdOrigin)) return authFail(400, env, "origin_whitelist");
    const challengeHash = await sha256Hex(cdChallenge);
    if (!timingSafeEqualHex(challengeHash, String(row.challenge_hash))) {
      return authFail(400, env, "challenge_hash");
    }

    // --- authenticatorData flags ---
    let authData = null;
    try {
      authData = bytesFromBase64Url(credential.response.authenticatorData);
      if (authData.length < 37) authData = null;
    } catch {
      authData = null;
    }
    if (!authData) return authFail(400, env, "authdata_missing");
    const flags = parseAuthDataFlags(authData);
    if (!flags || !flags.up) return authFail(400, env, "flags_up");
    if ((flags.be ? 1 : 0) === 0 && (flags.bs ? 1 : 0) === 1) return authFail(400, env, "be0_bs1");

    // --- credentialId 服务端绝对映射 ---
    const credentialId = String(credential.id || "");
    if (!credentialId) return authFail(400, env, "no_cred_id");
    const cred = await findActiveCredentialById(d1, credentialId);
    // 未知 credentialId：与签名失败返回同一模糊响应（防枚举）
    if (!cred) return authFail(401, env, "unknown_credential");

    // BE 与注册时一致校验；status='active' 已由 findActiveCredentialById 保证
    if ((flags.be ? 1 : 0) !== (cred.backup_eligible ? 1 : 0)) return authFail(401, env, "be_mismatch");

    const expectedRPID = String(row.rp_id || rpId(env));
    const storedCounter = Number(cred.sign_count) || 0;
    let publicKey;
    try {
      publicKey = bytesFromBase64Url(cred.public_key_cose);
    } catch {
      return authFail(401, env, "pubkey_decode");
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: cdChallenge,
      expectedOrigin: cdOrigin,
      expectedRPID,
      credential: {
        id: credentialId,
        publicKey,
        counter: storedCounter,
      },
      requireUserVerification: false,
    });
    if (!verification || verification.verified !== true) {
      return authFail(401, env, "verify_false");
    }
    const ai = (verification && verification.authenticationInfo) || {};
    const newCounter = Number(ai.newCounter) || 0;

    // signCount 策略（库内已做 >0 时必须严格递增；这里再按需重申语义）
    if (storedCounter > 0 && newCounter <= storedCounter) {
      return authFail(401, env, "clone_counter"); // 克隆/回退检测
    }

    // 生成 session token（明文只此一次返回，库中只存 SHA-256）
    const sessionToken = randomBase64Url(32);
    const sessionTokenHash = await sha256Hex(sessionToken);
    const ttlMs = sessionTtlMs(env);

    const result = await loginAtomic(d1, {
      ceremonyId,
      credentialId,
      storedSignCount: storedCounter,
      newSignCount: newCounter,
      backedUp: flags.bs,
      userVerified: flags.uv,
      userKey: String(cred.user_key),
      userUuid: cred.user_uuid ? String(cred.user_uuid) : "",
      sessionTokenHash,
      sessionTtlMs: ttlMs,
      mfaLevel: 1,
    });

    if (!(result.challengeConsumed && result.credentialUpdated && result.sessionInserted)) {
      return authFail(409, env, "concurrent"); // challenge 已消费 / signCount CAS 失败（并发回退）
    }

    return jsonResponse({
      ok: true,
      authMethod: "passkey",
      sessionToken, // 明文只此一次返回
      expiresAt: result.expiresAt,
      user: {
        userKey: String(cred.user_key),
        userUuid: cred.user_uuid ? String(cred.user_uuid) : "",
      },
    });
  } catch (e) {
    console.error("[passkey/authenticate/verify]", e);
    return authFail(401, env, "exception");
  }
}