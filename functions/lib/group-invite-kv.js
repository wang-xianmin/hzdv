/**
 * 小组六位邀请码 KV（invite:group:{group}），供 group-invite-code 与批量刷新共用。
 */
import { normalizeGroup } from "./group-index.js";

export function inviteKvKey(group) {
  return `invite:group:${group}`;
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

/** @returns {Promise<string>} 新生成的六位码 */
export async function writeNewInviteCodeToKv(kv, groupSanitized) {
  const code = randomSixDigitInvite();
  await kv.put(
    inviteKvKey(groupSanitized),
    JSON.stringify({
      code,
      updated_at: Date.now(),
    })
  );
  return code;
}
