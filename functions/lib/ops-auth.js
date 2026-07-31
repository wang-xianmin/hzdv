/**
 * 运维接口鉴权。
 * - assertOpsAccess：超管 | 技术调试员（AI 模型库、系统设置、llm-chat 等）
 * - assertHeroOpsAccess：超管 | 技术调试员 | 内容审核总负责 | 内容审核员（网站背景）
 */

import { readKvUser } from "./kv-secure.js";
import { pickKvBinding } from "./kv-binding.js";

const MASK_SUPER = 0x01;
const MASK_DBG = 0x02;
const MASK_CNT_MGR = 0x04;
const MASK_CNT_STF = 0x08;

/** 完整运维（模型库 / 系统设置 / llm 等） */
const OPS_FULL_MASK = MASK_SUPER | MASK_DBG;
/** 网站背景 */
const OPS_HERO_MASK = OPS_FULL_MASK | MASK_CNT_MGR | MASK_CNT_STF;

/** 正式收紧：不再对任意登录开放 */
const OPS_TEMP_OPEN_TO_ANY_LOGIN = false;

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

async function loadOpsUser(env, phone) {
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
  const typeMask = parseTypeMask(row.metadata.type);
  const gRole =
    row.value && row.value.g_role != null && Number(row.value.g_role) === 1
      ? 1
      : 0;
  return {
    phone: digits,
    metadata: row.metadata,
    value: row.value,
    typeMask,
    gRole,
  };
}

function denyIfNeeded(user, allowMask) {
  if (OPS_TEMP_OPEN_TO_ANY_LOGIN) return user;
  if ((user.typeMask & allowMask) === 0) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  return user;
}

/** 超管 | 技术调试员 */
export async function assertOpsAccess(env, phone) {
  const user = await loadOpsUser(env, phone);
  return denyIfNeeded(user, OPS_FULL_MASK);
}

/** 超管 | 技术调试员 | 内容审核岗（网站背景） */
export async function assertHeroOpsAccess(env, phone) {
  const user = await loadOpsUser(env, phone);
  return denyIfNeeded(user, OPS_HERO_MASK);
}

export function opsAuthErrorResponse(err) {
  const status = err && err.status ? err.status : 500;
  const message = String((err && err.message) || err || "unknown error");
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
