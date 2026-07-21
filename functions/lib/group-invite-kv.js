/**
 * 小组六位邀请码 KV（方案 A）：
 * 外层键 ig:{HMAC(HMAC_SECRET, "invite:group:"+group)}；value AES 加密。
 * 双读：先 ig: 后旧 invite:group:；新写仅 ig: 且 fail-closed。
 */
import { normalizeGroup } from "./group-index.js";
import {
  decryptKvInner,
  encryptKvInner,
  encryptionEnabled,
  hmacEnabled,
  hmacHex,
  requireOpaqueWriteSecrets,
} from "./kv-secure.js";

export const IG_PREFIX = "ig:";
export const LEGACY_INVITE_PREFIX = "invite:group:";

/** @deprecated 旧明文键；仅双读 / 清理 */
export function inviteKvKeyLegacy(group) {
  return LEGACY_INVITE_PREFIX + group;
}

/** 同步兼容旧名：无 env 时返回旧键（调用方应改用 inviteKvKeyOpaque） */
export function inviteKvKey(group) {
  return inviteKvKeyLegacy(group);
}

export async function inviteKvKeyOpaque(env, group) {
  const g = String(group || "");
  if (!g) throw new Error("Missing group for invite key");
  const mac = await hmacHex(env, "invite:group:" + g);
  return IG_PREFIX + mac;
}

export function sanitizeGroupForInvite(raw) {
  const s = normalizeGroup(raw);
  if (!s || s.length > 24) return "";
  if (!/^[\dA-Za-z._-]+$/.test(s)) return "";
  return s;
}

export function randomSixDigitInvite() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0] % 1000000;
  return String(n).padStart(6, "0");
}

export function normalizeSixDigitsFromStored(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "").slice(0, 6);
  return d.length === 6 ? d : "";
}

function parseInviteRaw(raw) {
  if (raw == null || typeof raw !== "string") return "";
  if (raw.startsWith("e1.")) return null; // encrypted — caller decrypts
  try {
    const o = JSON.parse(raw);
    return normalizeSixDigitsFromStored(o && o.code != null ? o.code : "");
  } catch {
    return "";
  }
}

/**
 * 双读邀请码：ig: → 旧 invite:group:
 * @returns {Promise<string>} 六位码或 ""
 */
export async function readInviteCodeFromKv(kv, env, groupSanitized) {
  if (!kv || !groupSanitized) return "";

  if (hmacEnabled(env) && encryptionEnabled(env)) {
    try {
      const sk = await inviteKvKeyOpaque(env, groupSanitized);
      const raw = await kv.get(sk);
      if (raw && typeof raw === "string") {
        if (raw.startsWith("e1.")) {
          const inner = await decryptKvInner(env, raw);
          const code = normalizeSixDigitsFromStored(inner && inner.code);
          if (code) return code;
        } else {
          const code = parseInviteRaw(raw);
          if (code) return code;
        }
      }
    } catch {
      /* fall through */
    }
  }

  const legacyRaw = await kv.get(inviteKvKeyLegacy(groupSanitized));
  return parseInviteRaw(legacyRaw) || "";
}

/** @returns {Promise<string>} 新生成的六位码；缺密钥 fail-closed */
export async function writeNewInviteCodeToKv(kv, env, groupSanitized) {
  requireOpaqueWriteSecrets(env);
  const code = randomSixDigitInvite();
  const sk = await inviteKvKeyOpaque(env, groupSanitized);
  const enc = await encryptKvInner(env, {
    v: 1,
    code,
    group: groupSanitized,
    updated_at: Date.now(),
  });
  await kv.put(sk, enc);
  try {
    await kv.delete(inviteKvKeyLegacy(groupSanitized));
  } catch {
    /* ignore */
  }
  return code;
}
