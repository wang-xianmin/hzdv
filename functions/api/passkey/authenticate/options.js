/**
 * POST /api/passkey/authenticate/options
 * 生成登录（assertion）ceremony。
 * 公开端点：带 phone（可选）时允许把 allowCredentials 收敛为该用户 active 凭据；
 * 不带 phone 即为完全 discoverable 模式。
 *
 * 反枚举：无论 phone 是否存在/是否有凭据，都返回同构的 options；
 * 用户不存在或凭据为空时不返回「用户不存在」信号，只返回空的 allowCredentials。
 */

import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { passkeyEnabled, rpId, challengeTtlMs } from "../../../lib/passkey-config.js";
import {
  pickD1,
  insertChallenge,
  findUserActiveCredentials,
} from "../../../lib/passkey-d1.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  fail,
} from "../../../lib/passkey-resp.js";
import { randomBase64Url, sha256Hex } from "../../../lib/passkey-crypto.js";
import { rateLimit, clientBucketId } from "../../../lib/passkey-rate.js";

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

  const ok = await rateLimit(env, "authn-options:" + clientBucketId(request), {
    limit: 15,
    windowMs: 60000,
  });
  if (!ok) return fail(429);

  const rpID = rpId(env);
  const ceremonyId = randomBase64Url(16);
  const challenge = randomBase64Url(32);
  const challengeHash = await sha256Hex(challenge);

  let allowCredentials = [];
  let userKeyForStore = null;
  const phone = String(body.phone || "").trim();
  if (phone) {
    const key = "phone:" + phone.replace(/\D/g, "");
    try {
      const rows = await findUserActiveCredentials(d1, key);
      allowCredentials = rows
        .filter((r) => r && r.credential_id)
        .map((r) => ({ type: "public-key", id: r.credential_id }));
      userKeyForStore = key;
    } catch (e) {
      allowCredentials = [];
      userKeyForStore = null;
    }
  }

  const opts = await generateAuthenticationOptions({
    rpID,
    challenge,
    allowCredentials,
    userVerification: "preferred",
    timeout: 60000,
  });
  // 显式下发 canonical challenge，保证 options 返回的 challenge 与存库 hash 一致
  opts.challenge = challenge;
  // WebAuthn L3 hints（实验性，浏览器可忽略）：优先引导跨设备/扫码，同时保留本机入口
  opts.hints = ["hybrid", "client-device"];

  await insertChallenge(d1, {
    ceremonyId,
    challengeHash,
    flow: "authenticate",
    userKey: userKeyForStore,
    allowedCredentialIds: allowCredentials.map((c) => c.id),
    rp_id: rpID,
    origin: new URL(request.url).origin,
    ttlMs: challengeTtlMs(env),
  });

  // 统一响应：不带「用户存在与否」的信号；为空 allowCredentials 等同 discoverable
  return jsonResponse({ ok: true, ceremonyId, publicKey: opts });
}