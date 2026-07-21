/**
 * 运维接口鉴权：超管 | 技术调试员（与前端 USER_TYPE_OPS_MENU 一致）。
 */

import { readKvUser } from "./kv-secure.js";
import { pickKvBinding } from "./kv-binding.js";

const OPS_TYPE_MASK = 0x01 | 0x02;

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

export async function assertOpsAccess(env, phone) {
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
  if ((mask & OPS_TYPE_MASK) === 0) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  return {
    phone: digits,
    metadata: row.metadata,
    value: row.value,
  };
}

export function opsAuthErrorResponse(err) {
  const status = err && err.status ? err.status : 500;
  const message = String((err && err.message) || err || "unknown error");
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
