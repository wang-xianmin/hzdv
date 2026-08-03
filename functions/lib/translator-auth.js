/**
 * 口译器鉴权：仅超级用户
 */

import { readKvUser } from "./kv-secure.js";
import { pickKvBinding } from "./kv-binding.js";

const MASK_SUPER = 0x01;

/** 正式收紧：不再对任意登录开放 */
const TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN = false;

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
  if (TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN) {
    return {
      phone: digits,
      metadata: row.metadata,
      value: row.value,
      typeMask: parseTypeMask(row.metadata.type),
    };
  }
  const mask = parseTypeMask(row.metadata.type);
  if ((mask & MASK_SUPER) === 0) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  return {
    phone: digits,
    metadata: row.metadata,
    value: row.value,
    typeMask: mask,
    gRole:
      row.value && row.value.g_role != null && Number(row.value.g_role) === 1
        ? 1
        : 0,
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
