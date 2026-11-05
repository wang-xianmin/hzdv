/**
 * POST /api/passkey/register/options
 * 生成注册 ceremony。
 * 需要服务端可验证身份：有效 auth_sessions 会话 或 /api/passkey/reauth 票据。
 * 不信任请求体里的 phone/uuid。
 */

import { generateRegistrationOptions } from "@simplewebauthn/server";
import { passkeyEnabled, rpId, rpName, challengeTtlMs } from "../../../lib/passkey-config.js";
import {
  pickD1,
  findUserActiveCredentials,
  insertChallenge,
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
  randomBase64Url,
  sha256Hex,
} from "../../../lib/passkey-crypto.js";

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

  const identity = await resolveIdentity(env, d1, request, body);
  if (!identity) return unauthorized();
  const userKey = identity.userKey;
  const userUuid = identity.userUuid || "";
  const label = String(body.name || "").trim().slice(0, 80) || "";

  try {
    const existing = await findUserActiveCredentials(d1, userKey);
    const excludeCredentials = existing
      .filter((c) => c && c.credential_id)
      .map((c) => ({ type: "public-key", id: c.credential_id }));

    const ceremonyId = randomBase64Url(16);
    // challenge 用 base64url 字符串；无论库内部如何处理，我们都显式地把要下发给浏览器的
    // canonical challenge 定为 challenge，并以其 SHA-256 存库，保证 options/verify/hash 三者严格一致。
    const challenge = randomBase64Url(32);
    const challengeHash = await sha256Hex(challenge);
    const userHandle = new TextEncoder().encode(
      userUuid ? userUuid : "u:" + userKey
    );
    const rpID = rpId(env);

    const opts = generateRegistrationOptions({
      rpName: rpName(env),
      rpID,
      userID: userHandle,
      userName: "user",
      userDisplayName: "user",
      attestationType: "none",
      timeout: 60000,
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: "preferred",
      },
      excludeCredentials: excludeCredentials,
    });

    // 显式覆盖下发给客户端的 challenge，确保与存库 hash 一致
    opts.challenge = challenge;

    await insertChallenge(d1, {
      ceremonyId,
      challengeHash,
      flow: "register",
      userKey,
      allowedCredentialIds: excludeCredentials.map((c) => c.id),
      rp_id: rpID,
      origin: new URL(request.url).origin,
      ttlMs: challengeTtlMs(env),
    });

    return jsonResponse({
      ok: true,
      ceremonyId,
      label,
      publicKey: opts,
    });
  } catch (e) {
    console.error("[passkey/register/options]", e);
    return fail(400);
  }
}