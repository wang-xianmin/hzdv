/** 零宽及 BOM，避免「看不见」的字符影响口令 */
const ZW_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * 仅去零宽 + trim；不做 NFKC。用于兼容历史上曾用「原始 UTF-8 字节」参与 KDF 的旧哈希。
 * @param {unknown} raw
 * @returns {string}
 */
export function stripPasswordOnly(raw) {
  return String(raw == null ? "" : raw).replace(ZW_RE, "").trim();
}

/**
 * 登录/存盘统一：去零宽 + trim + NFKC（全角英数等 → 半角兼容形）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizePasswordForAuth(raw) {
  return stripPasswordOnly(raw).normalize("NFKC");
}

/**
 * 写入 KV 前：若 pwd 为明文则规范化（哈希形态不改写）。
 * @param {Record<string, unknown> | null | undefined} value
 * @returns {Record<string, unknown>}
 */
export function normalizePasswordInValueObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out = { ...value };
  const p = out.pwd;
  // 历史偶发把编码串写入 pwd；凡 $ 前缀均视为「非明文」不参与 NFKC
  if (typeof p === "string" && p.length > 0 && p.charAt(0) !== "$") {
    out.pwd = normalizePasswordForAuth(p);
  }
  return out;
}
