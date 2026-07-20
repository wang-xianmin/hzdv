/**
 * 返回当前请求的客户端 IP（用于本地/Electron 调试）
 * GET /api/get-local-ip
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const forwarded = request.headers.get("X-Forwarded-For");
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    (forwarded ? forwarded.split(",")[0].trim() : "") ||
    "127.0.0.1";

  return jsonResponse({ success: true, ip });
}
