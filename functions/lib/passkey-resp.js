/**
 * Passkey 端点共享响应/错误工具。
 * 安全要求：错误响应统一模糊文案，禁止区分「用户不存在 / 未注册 passkey」。
 */

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/** 模糊失败文案（不泄露具体原因，避免账号枚举/探测）。 */
export const VAGUE_FAIL = "Passkey operation could not be completed";

export function fail(status = 400) {
  return jsonResponse({ ok: false, error: VAGUE_FAIL }, status);
}

export function methodNotAllowed() {
  return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
}

/** 灰度开关关闭时统一 404。 */
export function disabled() {
  return jsonResponse({ ok: false, error: "Not Found" }, 404);
}

export function notConfigured() {
  return jsonResponse({ ok: false, error: "Service not configured" }, 503);
}

export function unauthorized() {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}