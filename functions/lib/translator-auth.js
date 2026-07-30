/**
 * 口译器鉴权：按用户 type 掩码开放。
 * TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN=true 时：只要 KV 有该登录用户即可（Mac 联调）。
 */

import { readKvUser } from "./kv-secure.js";
import { pickKvBinding } from "./kv-binding.js";

/** 正式：超管 | A类 | B类（可按业务改） */
const TRANSLATOR_TYPE_MASK = 0x01 | 0x10 | 0x20;

/** 临时：登录用户均可；正式收紧时改 false */
const TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN = true;

function parseTypeMask(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return 0;
  if (/^[01]+$/.test(text)) return parseInt(text, 2) || 0;
  const n = Number(text);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

export async function assertTranslatorAccess(env, phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) {
    const err = new Error("Missing phone");
    err.status = 400;
    throw err;
  }
  const kv = pickKvBinding(env);
  if (!kv) {
    const err = new Error("KV not configured");
    err.status = 503;
    throw err;
  }
  const row = await readKvUser(kv, env, `phone:${digits}`);
  if (!row || !row.metadata) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  const mask = parseTypeMask(row.metadata.type);
  if (!TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN && (mask & TRANSLATOR_TYPE_MASK) === 0) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  return {
    phone: digits,
    metadata: row.metadata,
    value: row.value,
    typeMask: mask,
  };
}

export function translatorAuthErrorResponse(err) {
  const status = err && err.status ? err.status : 500;
  const message = String((err && err.message) || err || "unknown error");
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
