/**
 * 返回 Turnstile 前端配置（Site Key 从 Pages 环境变量读取）
 * GET /api/turnstile-config
 *
 * Pages 环境变量：
 *   TURNSTILE_SITE_KEY  — Site Key（公开，可返回前端）
 *   TURNSTILE_SECRET_KEY — Secret Key（绝不返回）
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const siteKey = String(env.TURNSTILE_SITE_KEY || "").trim();

  if (!siteKey) {
    return jsonResponse(
      { success: false, error: "TURNSTILE_SITE_KEY not configured" },
      503
    );
  }

  return jsonResponse({
    success: true,
    siteKey: siteKey,
  });
}
