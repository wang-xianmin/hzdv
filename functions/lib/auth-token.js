/**
 * 认证令牌签发与验证
 */
import { hmacHex, readKvUser } from './kv-secure.js';
import { pickKvBinding } from './kv-binding.js';

const DEFAULT_TTL_SEC = 2592000; // 30天

/**
 * 常量时间字符串比较
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Base64 URL 编码（无填充，URL安全）
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64UrlEncode(bytes) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64 URL 解码
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 签发认证令牌
 * @param {any} env
 * @param {string} phone 手机号（仅数字）
 * @param {object} options
 * @param {number} options.tv 令牌版本，默认 0
 * @param {number} options.ttlSec 令牌有效期（秒），默认 2592000
 * @returns {Promise<{ token: string, exp: number }>}
 */
export async function issueAuthToken(env, phone, { tv = 0, ttlSec = DEFAULT_TTL_SEC } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSec;
  const payload = {
    p: phone,
    iat: now,
    exp,
    tv,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const payloadB64 = base64UrlEncode(payloadBytes);
  
  const signature = await hmacHex(env, "auth-token:v1:" + payloadB64);
  const token = "v1." + payloadB64 + '.' + signature;
  
  return { token, exp };
}

/**
 * 验证令牌
 * @param {any} env
 * @param {string} token
 * @returns {Promise<{ phone: string, iat: number, exp: number, tv: number } | null>}
 */
export async function verifyAuthToken(env, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'v1') return null;
  const [, payloadB64, signature] = parts;
  
  // 验证签名
  let expectedSig;
  try {
    expectedSig = await hmacHex(env, "auth-token:v1:" + payloadB64);
  } catch {
    return null;
  }
  if (!constantTimeEqual(signature, expectedSig)) return null;
  
  // 解码 payload
  let payloadBytes;
  try {
    payloadBytes = base64UrlDecode(payloadB64);
  } catch {
    return null;
  }
  let payloadJson;
  try {
    payloadJson = new TextDecoder().decode(payloadBytes);
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  
  // 验证字段
  if (typeof payload !== 'object' || payload === null) return null;
  const { p, iat, exp, tv } = payload;
  if (typeof p !== 'string' || !/^\d{6,20}$/.test(p)) return null;
  if (typeof iat !== 'number' || !isFinite(iat)) return null;
  if (typeof exp !== 'number' || !isFinite(exp)) return null;
  if (typeof tv !== 'number' || !isFinite(tv)) return null;
  
  // 检查过期
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) return null;
  
  return { phone: p, iat, exp, tv };
}

/**
 * 从请求中提取令牌
 * @param {Request} request
 * @returns {string | null}
 */
export function readAuthTokenFromRequest(request) {
  // 1. 从 Cookie 头
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('hz_auth=')) {
        const token = cookie.slice('hz_auth='.length);
        if (token) return token;
      }
    }
  }
  
  // 2. 从 Authorization 头
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * 构建认证 Cookie 头值
 * @param {string} token
 * @param {number} maxAge 秒
 * @returns {string}
 */
export function buildAuthCookie(token, maxAge = DEFAULT_TTL_SEC) {
  return `hz_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * 构建清除认证的 Cookie 头值
 * @returns {string}
 */
export function buildClearAuthCookie() {
  return 'hz_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/**
 * 认证中间件
 * @param {any} context
 * @returns {Promise<{ phone: string, value: object, metadata: object, exp: number } | null>}
 */
export async function requireAuth(context) {
  const { request, env } = context;
  const token = readAuthTokenFromRequest(request);
  if (!token) return null;
  
  const verified = await verifyAuthToken(env, token);
  if (!verified) return null;
  
  const { phone, exp, tv } = verified;
  const kv = pickKvBinding(env);
  if (!kv) return null;
  
  try {
    const row = await readKvUser(kv, env, 'phone:' + phone);
    if (!row) return null;
    if (Number((row.value || {}).tv || 0) !== tv) return null;
    return {
      phone,
      value: row.value || {},
      metadata: row.metadata || {},
      exp,
    };
  } catch {
    // fail-closed: 任何异常都返回 null
    return null;
  }
}
