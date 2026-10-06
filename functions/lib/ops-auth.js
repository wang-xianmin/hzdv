/**
 * 运维接口鉴权。
 * 身份以 hz_auth 令牌为准（第 2b 步），客户端 phone 不参与认人。
 * - assertOpsAccess：超管 | 技术调试员（AI 模型库、系统设置等）
 * - assertHeroOpsAccess：超管 | 技术调试员 | 内容审核总负责 | 内容审核员（网站背景、产品目录、企业问答、发布栏）
 * - assertAnyLoginAccess：任意已注册用户（KV 有记录即可；AI 对话等，不与运维绑定）
 */

import { requireAuth } from "./auth-token.js";
import { roleOf } from "./auth-roles.js";

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

function opsAuthError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function loadOpsUser(env, _phone, request) {
  if (!request) throw opsAuthError(401, "AUTH_REQUIRED", "登录已过期，请重新登录");
  const auth = await requireAuth({ request, env });
  if (!auth) throw opsAuthError(401, "AUTH_REQUIRED", "登录已过期，请重新登录");
  const role = roleOf(auth);
  if (role.status === 3) throw opsAuthError(403, "USER_DELETED", "你已被注销，请联系系统管理员！");
  return {
    phone: auth.phone,
    metadata: auth.metadata,
    value: auth.value,
    typeMask: role.typeMask,
    gRole: role.isLeader ? 1 : 0,
  };
}

function denyIfNeeded(user, allowMask) {
  if (OPS_TEMP_OPEN_TO_ANY_LOGIN) return user;
  if ((user.typeMask & allowMask) === 0) {
    throw opsAuthError(403, "FORBIDDEN", "无权限");
  }
  return user;
}

/** 超管 | 技术调试员 */
export async function assertOpsAccess(env, phone, request) {
  const user = await loadOpsUser(env, phone, request);
  return denyIfNeeded(user, OPS_FULL_MASK);
}

/** 超管 | 技术调试员 | 内容审核岗（网站背景） */
export async function assertHeroOpsAccess(env, phone, request) {
  const user = await loadOpsUser(env, phone, request);
  return denyIfNeeded(user, OPS_HERO_MASK);
}

/** 产品目录：与网站背景同权 */
export async function assertCatalogOpsAccess(env, phone, request) {
  return assertHeroOpsAccess(env, phone, request);
}

/**
 * 任意已登录/已注册用户（不查 type / g_role）。
 * 用于 AI 助手对话等与「系统运维」解耦的接口。
 */
export async function assertAnyLoginAccess(env, phone, request) {
  return loadOpsUser(env, phone, request);
}

export function opsAuthErrorResponse(err) {
  const status = err && err.status ? err.status : 500;
  const message = String((err && err.message) || err || "unknown error");
  const body = err && err.code ? { success: false, code: err.code, error: message } : { success: false, error: message };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
