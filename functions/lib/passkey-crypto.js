/**
 * Passkey 密码学/编码工具。
 * - base64url 双向（用于 challenge / credential / COSE 公钥）
 * - SHA-256 hex（challenge / token hash 存储）
 * - HMAC-SHA256（reauth 票据签名，复用 kv-secure.hmacHex）
 * - 常量时间比较、随机 token
 * - 认证器数据 flags 解析（AT/UP/UV/BE/BS）
 */

import { hmacHex } from "./kv-secure.js";

function utf8(s) {
  return new TextEncoder().encode(s);
}

function hexFromBytes(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesFromBase64Url(s) {
  const b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = b64.length % 4;
  const b = b64 + "====".slice(0, padLen ? 4 - padLen : 0);
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function base64UrlFromBytes(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlFromString(s) {
  return base64UrlFromBytes(utf8(s));
}

export function stringFromBytes(u8) {
  return new TextDecoder().decode(u8);
}

export function base64UrlFromJson(obj) {
  return base64UrlFromString(JSON.stringify(obj));
}

export function jsonFromBase64Url(s) {
  return JSON.parse(stringFromBytes(bytesFromBase64Url(s)));
}

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function hmacSign(env, message) {
  return hmacHex(env, message);
}

/** 常量时间比较两个 hex 串 */
export function timingSafeEqualHex(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let x = 0;
  for (let i = 0; i < sa.length; i++) x |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return x === 0;
}

export function randomBytes(n) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}

export function randomBase64Url(n) {
  return base64UrlFromBytes(randomBytes(n));
}

/**
 * 解析 authenticatorData 的 flags 字节，返回 { up, uv, be, bs, at, flags }。
 * authData 布局：rpIdHash(32) | flags(1) | counter(4) | attestedCredentialData?...
 * flags: bit0=UP, bit2=UV, bit3=BE(backup_eligible), bit4=BS(backed_up), bit6=AT
 */
export function parseAuthDataFlags(authDataBytes) {
  if (!authDataBytes || authDataBytes.length < 37) return null;
  const f = authDataBytes[32];
  return {
    flags: f,
    up: (f & 0x01) === 0x01,
    uv: (f & 0x04) === 0x04,
    be: (f & 0x08) === 0x08,
    bs: (f & 0x10) === 0x10,
    at: (f & 0x40) === 0x40,
    rpIdHash: authDataBytes.slice(0, 32),
  };
}

/** 常量时间比较两个 Uint8Array */
export function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

/* ------------------------------------------------------------------ */
/* 极简 CBOR：从 attestationObject 里取出 authData 字节（用于解析 flags） */
/* 只支持本库要用到的顶层 map({1 fmt, 2 authData, ...})                 */
/* ------------------------------------------------------------------ */

function cborReadLen(b, i) {
  const b0 = b[i];
  const major = b0 >> 5;
  const info = b0 & 0x1f;
  if (info < 24) return { major, len: info, next: i + 1 };
  let nBytes;
  if (info === 24) nBytes = 1;
  else if (info === 25) nBytes = 2;
  else if (info === 26) nBytes = 4;
  else if (info === 27) nBytes = 8;
  else return { major, len: -1, next: i + 1 }; // 简单/特殊值
  let n = 0;
  for (let k = 0; k < nBytes; k++) n = n * 256 + b[i + 1 + k];
  return { major, len: n, next: i + 1 + nBytes };
}

function cborSkipValue(b, i, major, len) {
  if (major === 2 || major === 3) {
    return i + len; // 字节串/文本串：跳过内容
  }
  if (major === 4) {
    let p = i;
    for (let k = 0; k < len; k++) {
      const r = cborReadLen(b, p);
      p = r.next;
      // 只支持数组内元素为 bytestring/简单值（authData 场景不会嵌套复杂数组到这一层）
      if (r.major === 2) p += r.len;
    }
    return p;
  }
  if (major === 5) {
    let p = i;
    for (let k = 0; k < len * 2; k++) {
      const r = cborReadLen(b, p);
      p = r.next;
      if (r.major === 2 || r.major === 3) p += r.len;
    }
    return p;
  }
  // major 0/1 (int) 已在 readLen 消费；major 6/7 简单值或 tag
  return i;
}

/**
 * 从 attestationObject（CBOR 顶层 map）取 authData 原始字节。
 * 兼容 string key "authData" 与 integer key 2 两种编码。失败返回 null。
 */
export function extractAuthDataFromAttestationObject(attBytes) {
  if (!attBytes || attBytes.length < 3) return null;
  const top = cborReadLen(attBytes, 0);
  if (top.major !== 5) return null; // 必须是 map
  const fp = new TextDecoder();
  let p = top.next;
  // read each (key, value) pair
  for (let k = 0; k < top.len; k++) {
    const kk = cborReadLen(attBytes, p);
    const isTextKey = kk.major === 3;
    let keyVal = null;
    if (!isTextKey && kk.major === 0) keyVal = kk.len;
    else if (!isTextKey && kk.major === 1) keyVal = -1 - kk.len;
    p = kk.next;
    // 读取文本 key 内容；若恰为 "authData" 用字符串标记
    if (isTextKey && kk.len === 8) {
      keyVal = fp.decode(attBytes.slice(p, p + kk.len));
      p += kk.len;
    } else if (isTextKey) {
      p += kk.len;
    }
    const vv = cborReadLen(attBytes, p);
    if (vv.major === 2 && (keyVal === "authData" || keyVal === 2)) {
      return attBytes.slice(p + 1, p + 1 + vv.len);
    }
    p = cborSkipValue(attBytes, p + 1, vv.major, vv.len);
  }
  return null;
}

export { utf8, hexFromBytes, bytesFromHex };