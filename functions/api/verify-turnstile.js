/**
 * POST /api/verify-turnstile
 * 将前端 Turnstile token 交给 Cloudflare siteverify。
 * Pages 环境变量：TURNSTILE_SECRET_KEY（必填；勿写测试 Secret 进仓库）
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const token = body && body.token;
  if (!token) {
    return jsonResponse(
      { success: false, "error-codes": ["missing-input-response"] },
      400
    );
  }

  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    return jsonResponse(
      {
        success: false,
        "error-codes": ["missing-secret"],
        error: "TURNSTILE_SECRET_KEY not configured",
      },
      503
    );
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);

  let result;
  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    result = await r.json();
  } catch (e) {
    return jsonResponse(
      { success: false, "error-codes": ["internal-error"], detail: String(e) },
      502
    );
  }

  const status = result.success ? 200 : 400;
  return jsonResponse(result, status);
}
