/**
 * 用户数据接口的角色判定与响应工具（第 2a 步）
 * 角色口径与 check-user / wx-login-poll 一致：metadata.type 为空时回退 metadata.uA
 */

export function parseTypeMask(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return 0;
  if (/^[01]+$/.test(text)) return parseInt(text, 2) || 0;
  const n = Number(text);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

export function roleOf(row) {
  const v = (row && row.value) || {};
  const m = (row && row.metadata) || {};
  const rawType = m.type != null && String(m.type) !== "" ? m.type : m.uA;
  const typeMask = parseTypeMask(rawType);
  const status = parseInt(m.status, 10);
  return {
    typeMask,
    isSuper: (typeMask & 1) !== 0,
    isDbg: (typeMask & 2) !== 0,
    isLeader: Number(v.g_role) === 1,
    group: String(v.group == null ? "" : v.group).trim(),
    status: Number.isNaN(status) ? null : status,
  };
}

/** 只能由服务器维护的 value 字段 */
export const SERVER_MANAGED_VALUE_KEYS = ["tv", "pwd_hash", "wxu", "wxu_type"];

export function keepServerManagedValueKeys(merged, prevValue) {
  const prev = prevValue || {};
  SERVER_MANAGED_VALUE_KEYS.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(prev, k)) merged[k] = prev[k];
    else delete merged[k];
  });
  return merged;
}

export function sanitizeValueForViewer(value, showPwd) {
  const out = Object.assign({}, value || {});
  delete out.pwd_hash;
  out.pwd = showPwd ? String(out.pwd == null ? "" : out.pwd) : "";
  return out;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function authRequiredResponse() {
  return json({ success: false, code: "AUTH_REQUIRED", error: "登录已过期，请重新登录" }, 401);
}

export function forbiddenResponse(message) {
  return json({ success: false, code: "FORBIDDEN", error: message || "无权限" }, 403);
}

export function deletedCallerResponse() {
  return json({ success: false, code: "USER_DELETED", error: "你已被注销，请联系系统管理员！" }, 403);
}
