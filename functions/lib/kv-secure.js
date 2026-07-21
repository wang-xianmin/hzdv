/**
 * Cloudflare KV 安全存储（喂PDF0409 + 方案 A HMAC-as-key）：
 * - ENCRYPTION_KEY：AES-256-GCM 加密内层 JSON（uuid/name/email/pwd 哈希/savedAt/keyMac/logicalKey）
 * - HMAC_SECRET：① 对逻辑 key（phone:138…）做 HMAC → 外层存储键 uk:{hex}；② 内层 keyMac 仍签逻辑 key
 * - 新写 fail-closed：ENCRYPTION_KEY 与 HMAC_SECRET 均须配置
 * - 读路径：先 uk: 后旧 phone:（只读双读，不写回）
 * - Argon2id/KDF 哈希写入 value.pwd_hash（保留 value.pwd 供业务展示/编辑）
 */

import {
  normalizePasswordForAuth,
  normalizePasswordInValueObject,
  stripPasswordOnly,
} from "./password-normalize.js";

const ENC_PREFIX = "e1.";
/** 外层 opaque 用户主记录前缀（方案 A） */
export const UK_PREFIX = "uk:";
/** 旧版明文主记录前缀（仅只读双读） */
export const LEGACY_PHONE_PREFIX = "phone:";

function utf8(s) {
  return new TextEncoder().encode(s);
}

function hex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

/** @param {string} s */
function decodeKeyMaterial(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  try {
    const bin = atob(t.replace(/\s/g, ""));
    if (bin.length === 32) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {
    /* ignore */
  }
  const u = utf8(t);
  if (u.length === 32) return u;
  return null;
}

export function parseAesKey(env) {
  return decodeKeyMaterial(env.ENCRYPTION_KEY);
}

export function parseHmacSecret(env) {
  const t = String(env.HMAC_SECRET || "").trim();
  if (!t) return null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return utf8(t);
}

export function encryptionEnabled(env) {
  return parseAesKey(env) != null;
}

export function hmacEnabled(env) {
  const s = parseHmacSecret(env);
  return s != null && s.byteLength > 0;
}

export function assertPhoneKey(key) {
  if (typeof key !== "string" || !/^phone:\d{6,20}$/.test(key)) {
    throw new Error("Invalid key: expected phone:digits (6–20)");
  }
}

/** 新写必须同时具备 AES 与 HMAC；缺失则 fail-closed */
export function requireOpaqueWriteSecrets(env) {
  if (!encryptionEnabled(env) || !hmacEnabled(env)) {
    throw new Error(
      "ENCRYPTION_KEY and HMAC_SECRET required for new KV writes (fail-closed)"
    );
  }
}

/**
 * HMAC-SHA256 hex（message 为 UTF-8 字符串）
 * @param {any} env
 * @param {string} message
 */
export async function hmacHex(env, message) {
  const sec = parseHmacSecret(env);
  if (!sec) throw new Error("HMAC_SECRET missing");
  const k = await crypto.subtle.importKey(
    "raw",
    sec,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, utf8(String(message)));
  return hex(new Uint8Array(sig));
}

/**
 * 逻辑 key（phone:digits）→ 外层存储键 uk:{HMAC(HMAC_SECRET, "phone:"+phone)}
 * @param {any} env
 * @param {string} logicalKey
 */
export async function phoneToStorageKey(env, logicalKey) {
  assertPhoneKey(logicalKey);
  const mac = await hmacHex(env, logicalKey);
  return UK_PREFIX + mac;
}

export function isUkStorageKey(key) {
  return typeof key === "string" && key.startsWith(UK_PREFIX);
}

export function isLegacyPhoneStorageKey(key) {
  return typeof key === "string" && /^phone:\d{6,20}$/.test(key);
}

/**
 * 双读存在性：先 uk: 后旧 phone:
 * @returns {Promise<boolean>}
 */
export async function kvUserExists(kv, env, logicalKey) {
  assertPhoneKey(logicalKey);
  if (hmacEnabled(env)) {
    try {
      const sk = await phoneToStorageKey(env, logicalKey);
      const v = await kv.get(sk);
      if (v != null) return true;
    } catch {
      /* fall through */
    }
  }
  const legacy = await kv.get(logicalKey);
  return legacy != null;
}

/**
 * 删除主记录：新旧键都删（幂等）
 */
export async function deleteKvUser(kv, env, logicalKey) {
  assertPhoneKey(logicalKey);
  const jobs = [kv.delete(logicalKey)];
  if (hmacEnabled(env)) {
    try {
      const sk = await phoneToStorageKey(env, logicalKey);
      jobs.push(kv.delete(sk));
    } catch {
      /* ignore */
    }
  }
  await Promise.all(jobs);
}

/**
 * 列出全部用户存储键（uk: + 旧 phone:），供扫描/重建。
 * @returns {Promise<string[]>}
 */
export async function listKvUserStorageKeys(kv) {
  const out = [];
  for (const prefix of [UK_PREFIX, LEGACY_PHONE_PREFIX]) {
    let cursor;
    do {
      const page = await kv.list({ prefix, limit: 1000, cursor });
      const keys = (page && page.keys) || [];
      for (const k of keys) {
        if (k && k.name) {
          if (prefix === LEGACY_PHONE_PREFIX && !isLegacyPhoneStorageKey(k.name)) {
            continue;
          }
          out.push(k.name);
        }
      }
      cursor = page && !page.list_complete ? page.cursor : undefined;
    } while (cursor);
  }
  return out;
}

function isProbablyArgon2Encoded(s) {
  return typeof s === "string" && s.startsWith("$argon2");
}

function parsePositiveInt(v, fallback) {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getArgon2Config(env) {
  const memoryKib = parsePositiveInt(env.ARGON2_MEMORY_KIB, 8192);
  const timeCost = parsePositiveInt(env.ARGON2_TIME_COST, 1);
  const parallelism = parsePositiveInt(env.ARGON2_PARALLELISM, 1);
  const hashLen = parsePositiveInt(env.ARGON2_HASH_LEN, 32);
  return { memoryKib, timeCost, parallelism, hashLen };
}

function concatBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * 轻量 KDF（用于兼容 Pages 打包环境，避免外部 argon2 依赖）
 * 非 Argon2，但包含 salt + 多轮迭代；编码格式为 $kdf-sha256$...
 */
async function derivePasswordHashSha256(password, salt, rounds, dkLen) {
  const pass = utf8(String(password || ""));
  const saltBytes = salt instanceof Uint8Array ? salt : utf8(String(salt || ""));
  const r = Math.max(1, rounds | 0);
  const outLen = Math.max(16, dkLen | 0);

  let state = concatBytes([pass, saltBytes]);
  for (let i = 0; i < r; i++) {
    state = await sha256(concatBytes([state, saltBytes, utf8(String(i))]));
  }
  if (outLen <= state.length) return state.slice(0, outLen);

  const blocks = [state];
  while (concatBytes(blocks).length < outLen) {
    const counter = utf8(String(blocks.length));
    blocks.push(await sha256(concatBytes([state, saltBytes, counter])));
  }
  return concatBytes(blocks).slice(0, outLen);
}

function normalizeValuePwdShape(valueObj) {
  if (!valueObj || typeof valueObj !== "object") return valueObj;
  const out = { ...valueObj };
  if (
    typeof out.pwd === "string" &&
    out.pwd &&
    isProbablyArgon2Encoded(out.pwd) &&
    (out.pwd_hash == null || out.pwd_hash === "")
  ) {
    out.pwd_hash = out.pwd;
    out.pwd = "";
  }
  return out;
}

export async function hashPasswordArgon2id(env, password) {
  const cfg = getArgon2Config(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rounds = Math.max(1, cfg.timeCost * 4000);
  const hashBytes = await derivePasswordHashSha256(password, salt, rounds, cfg.hashLen);
  return [
    "$kdf-sha256",
    "v=1",
    "r=" + rounds + ",l=" + cfg.hashLen,
    b64FromBytes(salt),
    b64FromBytes(hashBytes),
  ].join("$");
}

export async function verifyPasswordArgon2idEncoded(password, encoded) {
  if (typeof encoded !== "string" || encoded.indexOf("$") !== 0) {
    return false;
  }
  if (encoded.indexOf("$kdf-sha256$") === 0) {
    try {
      const parts = encoded.split("$");
      if (parts.length < 6) return false;
      const cfg = String(parts[3] || "");
      const salt = bytesFromB64(parts[4] || "");
      const hash = bytesFromB64(parts[5] || "");
      const rMatch = cfg.match(/(?:^|,)r=(\d+)/);
      const lMatch = cfg.match(/(?:^|,)l=(\d+)/);
      const rounds = rMatch ? parseInt(rMatch[1], 10) : 4000;
      const outLen = lMatch ? parseInt(lMatch[1], 10) : hash.length || 32;
      const got = await derivePasswordHashSha256(password, salt, rounds, outLen);
      return timingSafeEqualBytes(got, hash);
    } catch {
      return false;
    }
  }
  // 历史 Argon2 编码在当前 Pages 打包环境下不再新增，旧值保留但此路径返回 false。
  // check-user 会附带 password_hash_format，便于区分「真错密」与「哈希格式未实现」。
  if (encoded.indexOf("$argon2id$") !== 0) return false;
  try {
    return false;
  } catch {
    return false;
  }
}

/**
 * 先按 NFKC 口令验 KDF；失败时再试仅 strip（兼容旧数据用原始全角串参与 KDF 的情形）。
 * @param {unknown} passwordRaw
 * @param {string} encoded
 */
export async function verifyPasswordArgon2idEncodedFlexible(passwordRaw, encoded) {
  const norm = normalizePasswordForAuth(passwordRaw);
  if (await verifyPasswordArgon2idEncoded(norm, encoded)) return true;
  const stripped = stripPasswordOnly(passwordRaw);
  if (stripped !== norm && (await verifyPasswordArgon2idEncoded(stripped, encoded))) return true;
  return false;
}

/**
 * 将 value 对象中的明文 pwd 换为 Argon2id 编码串（已是 $argon2 则跳过）
 * @param {Record<string, unknown>} value
 */
export async function hashPwdInValue(env, value) {
  if (!encryptionEnabled(env)) return value;
  if (!value || typeof value !== "object") return value;
  const out = { ...value };
  const p = out.pwd;
  // 兼容旧数据：如果历史把哈希写进了 pwd，迁移到 pwd_hash 并清空展示位
  if (typeof p === "string" && p.length > 0 && isProbablyArgon2Encoded(p)) {
    out.pwd_hash = p;
    out.pwd = "";
    return out;
  }
  if (typeof p === "string" && p.length > 0) {
    const norm = normalizePasswordForAuth(p);
    out.pwd_hash = await hashPasswordArgon2id(env, norm);
    out.pwd = norm;
  }
  return out;
}

async function computeKeyMac(env, kvKey) {
  const sec = parseHmacSecret(env);
  if (!sec) return "";
  const k = await crypto.subtle.importKey(
    "raw",
    sec,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, utf8(kvKey));
  return hex(new Uint8Array(sig));
}

function b64FromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {Record<string, unknown>} inner - { v, value, savedAt, keyMac, metadata? }
 */
export async function encryptKvInner(env, inner) {
  const rawKey = parseAesKey(env);
  if (!rawKey) throw new Error("ENCRYPTION_KEY missing");
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const plain = utf8(JSON.stringify(inner));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      plain
    )
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return ENC_PREFIX + b64FromBytes(combined);
}

export async function decryptKvInner(env, stored) {
  const rawKey = parseAesKey(env);
  if (!rawKey) throw new Error("ENCRYPTION_KEY missing");
  if (typeof stored !== "string" || !stored.startsWith(ENC_PREFIX)) {
    throw new Error("Not an encrypted KV value");
  }
  const combined = bytesFromB64(stored.slice(ENC_PREFIX.length));
  if (combined.length < 16 + 16) throw new Error("Ciphertext too short");
  const iv = combined.slice(0, 16);
  const ct = combined.slice(16);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    ct
  );
  const inner = JSON.parse(new TextDecoder().decode(plain));
  if (!inner || typeof inner !== "object") throw new Error("Invalid inner payload");
  return inner;
}

async function verifyKeyMacIfNeeded(env, kvKey, macHex) {
  if (!hmacEnabled(env)) return;
  const expected = await computeKeyMac(env, kvKey);
  const got = typeof macHex === "string" ? macHex : "";
  if (!timingSafeEqualHex(expected, got)) {
    throw new Error("KV key 完整性校验失败");
  }
}

/**
 * 在已知存储键上解析一条用户记录（不做双读 / 不写回）
 * @param {string} storageKey
 * @param {string|null} logicalKeyHint - 已知逻辑 key 时用于 keyMac 校验；uk 记录可从 inner.logicalKey 取得
 * @returns {Promise<{ value: object, metadata: object, savedAt?: number, logicalKey: string, storageKey: string } | null>}
 */
async function readKvUserAtStorageKey(kv, env, storageKey, logicalKeyHint) {
  const got = await kv.getWithMetadata(storageKey);
  if (!got || got.value == null) return null;

  const raw = got.value;
  const metaRaw = got.metadata;
  let logicalKey =
    typeof logicalKeyHint === "string" && logicalKeyHint
      ? logicalKeyHint
      : isLegacyPhoneStorageKey(storageKey)
        ? storageKey
        : "";

  if (encryptionEnabled(env) && typeof raw === "string" && raw.startsWith(ENC_PREFIX)) {
    const inner = await decryptKvInner(env, raw);
    if (typeof inner.logicalKey === "string" && /^phone:\d{6,20}$/.test(inner.logicalKey)) {
      logicalKey = inner.logicalKey;
    }
    if (!logicalKey) {
      throw new Error("Encrypted KV record missing logicalKey");
    }
    await verifyKeyMacIfNeeded(env, logicalKey, inner.keyMac);
    if (!inner.value || typeof inner.value !== "object") {
      throw new Error("Invalid value in encrypted payload");
    }
    let metadata;
    if (inner.v >= 2 && inner.metadata && typeof inner.metadata === "object") {
      metadata = inner.metadata;
    } else {
      if (metaRaw == null || metaRaw === "") {
        throw new Error("加密记录缺少 metadata");
      }
      metadata = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
    }
    return {
      value: normalizeValuePwdShape(inner.value),
      metadata,
      savedAt: inner.savedAt,
      logicalKey,
      storageKey,
    };
  }

  if (typeof raw !== "string") {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.value !== "object" || obj.value === null) return null;
  if (typeof obj.metadata !== "object" || obj.metadata === null) return null;
  if (!logicalKey) {
    if (isLegacyPhoneStorageKey(storageKey)) logicalKey = storageKey;
    else return null;
  }
  return {
    value: normalizeValuePwdShape(obj.value),
    metadata: obj.metadata,
    savedAt: obj.savedAt,
    logicalKey,
    storageKey,
  };
}

/**
 * 写入：仅写 uk:（禁止新用户再写明文 phone:）。ENCRYPTION_KEY / HMAC_SECRET 缺失 → fail-closed。
 * keyMac / logicalKey 使用逻辑 phone: 键。写成功后若存在旧 phone: 则删除。
 */
export async function writeKvUser(kv, env, kvKey, value, metadata) {
  assertPhoneKey(kvKey);
  requireOpaqueWriteSecrets(env);
  const storageKey = await phoneToStorageKey(env, kvKey);
  const savedAt = Date.now();
  const valueForStore = await hashPwdInValue(env, normalizePasswordInValueObject(value));

  const keyMac = await computeKeyMac(env, kvKey);
  const metaObj =
    metadata && typeof metadata === "object" ? { ...metadata } : {};
  const inner = {
    v: 2,
    value: valueForStore,
    metadata: metaObj,
    savedAt,
    keyMac,
    logicalKey: kvKey,
  };
  const enc = await encryptKvInner(env, inner);
  /** Workers KV 附属 metadata 上限 1024 字节；完整权限表在密文 inner.metadata */
  const sidecar = {
    _kv: 2,
    s: metaObj.status != null ? Number(metaObj.status) || 0 : 0,
  };
  const metaStr = JSON.stringify(sidecar);
  if (metaStr.length > 1024) {
    throw new Error("KV 附属 metadata 占位仍超长（内部错误）");
  }
  await kv.put(storageKey, enc, { metadata: metaStr });
  try {
    await kv.delete(kvKey);
  } catch {
    /* ignore legacy cleanup */
  }
}

/**
 * 读出并解密；双读 uk: → 旧 phone:（只读兜底，不写回）。
 * @returns {Promise<{ value: object, metadata: object, savedAt?: number, logicalKey?: string, storageKey?: string } | null>}
 */
export async function readKvUser(kv, env, kvKey) {
  assertPhoneKey(kvKey);

  if (hmacEnabled(env)) {
    try {
      const sk = await phoneToStorageKey(env, kvKey);
      const neo = await readKvUserAtStorageKey(kv, env, sk, kvKey);
      if (neo) return neo;
    } catch (e) {
      /* 新键损坏时仍尝试旧键 */
      console.warn("readKvUser uk: failed, trying legacy:", e);
    }
  }

  return readKvUserAtStorageKey(kv, env, kvKey, kvKey);
}

/**
 * 按存储键读取（list 扫描用）；返回逻辑 key 便于 API 对外仍用 phone:
 */
export async function readKvUserByStorageKey(kv, env, storageKey) {
  if (isLegacyPhoneStorageKey(storageKey)) {
    return readKvUser(kv, env, storageKey);
  }
  if (isUkStorageKey(storageKey)) {
    return readKvUserAtStorageKey(kv, env, storageKey, null);
  }
  return null;
}
