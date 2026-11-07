/**
 * Passkey 服务端身份：auth_sessions 会话 + reauth 一次性票据。
 *
 * 原则：
 * - 注册前必须有服务端可验证身份（有效会话 或 5 分钟 reauth 票据），
 *   绝不信任 localStorage 里的 phone/uuid。
 * - reauth 票据格式：pkrt.<payloadJSON(base64url)>.<signature hex>
 *   payloadJSON = { userKey, userUuid, nonce, iat, exp }；signature = HMAC(HMAC_SECRET, payloadJSON)。
 * - nonce 记入 D1（auth_sessions, auth_method='reauth'），验签成功且行存在才有效；
 *   注册完成后消费（DELETE）即严格一次性。
 * - 会话 token 为随机 256-bit，D1 只存 SHA-256。
 */

import {
  randomBase64Url,
  base64UrlFromString,
  jsonFromBase64Url,
  sha256Hex,
  hmacSign,
  timingSafeEqualHex,
} from "./passkey-crypto.js";
import { reauthTtlMs } from "./passkey-config.js";
import {
  insertAuthGrant,
  findActiveAuthGrant,
  consumeAuthGrant,
} from "./passkey-d1.js";
import { hmacEnabled } from "./kv-secure.js";
import { requireAuth } from "./auth-token.js";

export const REAUTH_PREFIX = "pkrt.";

function parseCookieHeader(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
      }
    });
  return out;
}

/**
 * 签发 reauth 票据。票据体签名 + D1 记录 nonce（一次性）。
 */
export async function issueReauthTicket(env, d1, { userKey, userUuid, mfaLevel = 1 }) {
  if (!hmacEnabled(env)) throw new Error("HMAC_SECRET missing for reauth");
  const iat = Date.now();
  const exp = iat + reauthTtlMs(env);
  const nonce = randomBase64Url(16);
  const payload = { userKey, userUuid: userUuid || "", nonce, iat, exp };
  const payloadStr = [];
  payloadStr.push(JSON.stringify(payload));
  const payloadB64 = base64UrlFromString(payloadStr[0]);
  const sig = await hmacSign(env, payloadStr[0]);
  const token = `${REAUTH_PREFIX}${payloadB64}.${sig}`;
  const tokenHash = await sha256Hex(token);

  await insertAuthGrant(d1, {
    tokenHash,
    userKey,
    userUuid: userUuid || "",
    authMethod: "reauth",
    mfaLevel,
    ttlMs: reauthTtlMs(env),
  });

  return { token, payload, expiresAt: exp, nonce };
}

/**
 * 校验 reauth 票据：签名 + exp + D1 行存在（未消费）。
 * 不消费；成功调用方负责调用 consumeReauthTicket 实现一次性。
 */
export async function verifyReauthTicket(env, d1, token) {
  const t = String(token || "");
  if (t.indexOf(REAUTH_PREFIX) !== 0) return null;
  const parts = t.slice(REAUTH_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const payloadB64 = parts[0];
  const sigProvided = parts[1];
  let payloadStr;
  try {
    payloadStr = new TextDecoder().decode(
      // reuse base64url decode via jsonFromBase64Url's path is not ideal; decode text below
      Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    );
  } catch {
    return null;
  }
  const sig = await hmacSign(env, payloadStr);
  if (!timingSafeEqualHex(sig, sigProvided)) return null;

  let payload;
  try {
    payload = jsonFromBase64Url(payloadB64);
  } catch {
    return null;
  }
  const now = Date.now();
  if (!payload || typeof payload.userKey !== "string" || !payload.nonce) return null;
  if (now > Number(payload.exp)) return null;
  if (Number(payload.iat) > now + 60000) return null;

  const tokenHash = await sha256Hex(t);
  const row = await findActiveAuthGrant(d1, tokenHash, ["reauth"]);
  if (!row) return null;

  return {
    userKey: String(row.user_key),
    userUuid: row.user_uuid ? String(row.user_uuid) : "",
    nonce: payload.nonce,
    exp: Number(payload.exp),
    kind: "reauth",
  };
}

/** 消费 reauth 票据（一次性）。 */
export async function consumeReauthTicket(env, d1, token) {
  const t = String(token || "");
  if (t.indexOf(REAUTH_PREFIX) !== 0) return false;
  const tokenHash = await sha256Hex(t);
  return consumeAuthGrant(d1, tokenHash);
}

/** 签发长期会话。返回明文 token（只给返回给浏览器），DB 存 SHA-256。 */
export async function createAuthSession(d1, { userKey, userUuid, mfaLevel = 1, ttlMs = 7 * 86400000 }) {
  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const { expiresAt } = await insertAuthGrant(d1, {
    tokenHash,
    userKey,
    userUuid: userUuid || "",
    authMethod: "session",
    mfaLevel,
    ttlMs,
  });
  return { token, expiresAt };
}

/** 校验长期会话。 */
export async function verifyAuthSession(d1, token) {
  const t = String(token || "");
  if (!t || t.indexOf(REAUTH_PREFIX) === 0) return null;
  const tokenHash = await sha256Hex(t);
  const row = await findActiveAuthGrant(d1, tokenHash, ["session"]);
  if (!row) return null;
  return {
    userKey: String(row.user_key),
    userUuid: row.user_uuid ? String(row.user_uuid) : "",
    kind: "session",
    expiresAt: Number(row.expires_at),
  };
}

/**
 * 桥接站点 auth-token（hz_auth Cookie / Authorization: Bearer）。
 *
 * 与 requireAuth 完全同源：签名 + tv 校验 + 超管二次验证 + KV 记录存在，
 * 全部在服务端完成；前端拿不到、也不需要 KV 密码。
 * 只在 session / reauth 都解析不出来时兜底。
 */
async function resolveSiteTokenIdentity(env, request) {
  let auth = null;
  try {
    auth = await requireAuth({ request, env });
  } catch {
    return null; // fail-closed：任何异常都视为未登录
  }
  if (!auth || !auth.phone) return null;
  const value = auth.value || {};
  const userUuid = value.uuid != null ? String(value.uuid) : "";
  return {
    userKey: "phone:" + String(auth.phone),
    userUuid,
    kind: "auth_token",
    expiresAt: Number(auth.exp || 0),
    mfaLevel: auth.mfa ? 2 : 1,
  };
}

/**
 * 从请求解析身份。优先级：Cookie → Authorization → body 字段。
 * 支持重票据（pkrt.）与会话 token；都没有时兜底桥接站点 auth-token。
 * 返回 identity 或 null。
 *
 * @param {Object=} options {allowSiteToken:false} 时禁用 auth-token 桥接
 *        （撤销等敏感操作仍要求 passkey 会话或 reauth 票据）。
 *
 * 每个候选单独 try/catch：单个候选校验抛错只跳过该候选，
 * 不影响后续候选与最后的站点 auth-token 兜底。
 */
export async function resolveIdentity(env, d1, request, body, options) {
  const cookie = parseCookieHeader(request.headers.get("cookie"));
  const authz = String(request.headers.get("authorization") || "").trim();

  const candidates = [];
  const push = (tok) => {
    if (tok && typeof tok === "string" && tok.trim()) candidates.push(tok.trim());
  };
  push(cookie["__Host-pk_reauth"]);
  push(cookie["pk_reauth"]);
  push(cookie["__Host-hzdv_session"]);
  push(cookie["hzdv_session"]);
  if (authz.indexOf("Bearer ") === 0) push(authz.slice(7));
  push((body && body.reauthToken) || null);
  push((body && body.sessionToken) || null);
  if (cookie["__Host-pk_reauth"]) candidates.push(cookie["__Host-pk_reauth"]);
  if (cookie["pk_reauth"]) candidates.push(cookie["pk_reauth"]);
  if (cookie["__Host-hzdv_session"]) candidates.push(cookie["__Host-hzdv_session"]);
  if (cookie["hzdv_session"]) candidates.push(cookie["hzdv_session"]);

  const seen = new Set();
  for (const tok of candidates) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    try {
      if (tok.indexOf(REAUTH_PREFIX) === 0) {
        const id = await verifyReauthTicket(env, d1, tok);
        if (id) return id;
      } else {
        const id = await verifyAuthSession(d1, tok);
        if (id) return id;
      }
    } catch (err) {
      // 单个候选抛错（坏 Cookie / 损坏票据 / D1 抖动 / 票据签发失败）不能整段失败：
      // 继续试下一个候选，最后仍会兜底到站点 auth-token（hz_auth）。
      // 否则一个坏 Cookie 就会把「站点登录态可用的请求」打成 401。
      continue;
    }
  }
  // 兜底：站点 auth-token（hz_auth Cookie / Bearer）。仅登录态即可，
  // 因此对敏感操作（撤销）可显式关闭。
  const opts = options || {};
  if (opts.allowSiteToken === false) return null;
  return await resolveSiteTokenIdentity(env, request);
}

/* ------------------------------------------------------------------ */
/* 邮箱一次性验证码（reauth email 分支）                               */
/* ------------------------------------------------------------------ */

/** 简单邮箱归一化（与现有 send-email-code 对齐，gmail 别名忽略点号/+tag） */
export function normalizeEmail(v) {
  const raw = String(v || "").trim().toLowerCase();
  if (!raw || raw.indexOf("@") < 0) return raw;
  const at = raw.lastIndexOf("@");
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return local + "@" + domain;
}

async function emailCodeTokenHash(email, code) {
  return sha256Hex("emcode:" + normalizeEmail(email) + ":" + String(code));
}

/**
 * 生成并入账一个邮箱一次性验证码（6 位数字）。
 * 发出方需通过邮件发送给用户。结果（code）只存 SHA-256。
 */
export async function issueEmailReauthCode(env, d1, { userKey, userUuid, email, ttlMs = 300000 }) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const emailNorm = normalizeEmail(email);
  // 重新签发前清理旧码（同一邮箱只保留一个有效码）
  await consumeAuthGrant(d1, await emailCodeTokenHash(emailNorm, code));
  await insertAuthGrant(d1, {
    tokenHash: await emailCodeTokenHash(emailNorm, code),
    userKey,
    userUuid: userUuid || "",
    authMethod: "email_code",
    mfaLevel: 1,
    ttlMs,
  });
  return { code };
}

/** 校验邮箱一次性验证码并消费（一次性）。email 需与账号存储邮箱一致。 */
export async function verifyEmailReauthCode(d1, { email, code }) {
  const tokenHash = await emailCodeTokenHash(email, code);
  const row = await findActiveAuthGrant(d1, tokenHash, ["email_code"]);
  if (!row) return null;
  const consumed = await consumeAuthGrant(d1, tokenHash);
  if (!consumed) return null;
  return {
    userKey: String(row.user_key),
    userUuid: row.user_uuid ? String(row.user_uuid) : "",
    kind: "email_code",
  };
}

export { parseCookieHeader };