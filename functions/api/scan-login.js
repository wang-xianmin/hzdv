import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 扫码登录 API：GET /api/scan-login?sessionId=xxx
 * POST：手机端回写扫码结果；写入前须校验 Turnstile（TURNSTILE_SECRET_KEY）。
 * Pages 里绑定的变量名必须与代码一致（常用 my_kv）；也兼容旧名 MY_KV。
 */
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

/** 兼容多种查询参数名（URL 查询键区分大小写） */
function getQuerySessionId(url) {
  const p = url.searchParams;
  return (
    p.get("sessionId") ||
    p.get("sessionid") ||
    p.get("key") ||
    p.get("Key")
  );
}

async function verifyTurnstileWithEnv(env, token) {
  if (!token) {
    return { ok: false, error: "Missing turnstileToken", httpStatus: 400 };
  }
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    return {
      ok: false,
      error: "TURNSTILE_SECRET_KEY not configured",
      httpStatus: 503,
    };
  }
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", String(token));
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
    return { ok: false, error: "siteverify failed", detail: String(e), httpStatus: 502 };
  }
  if (!result || !result.success) {
    return {
      ok: false,
      error: "Turnstile verification failed",
      result,
      httpStatus: 403,
    };
  }
  return { ok: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = getQuerySessionId(url);

  try {
    const kv = pickKvBinding(env);
    if (!kv) {
      return jsonResponse(
        {
          exists: false,
          msg: "Server KV not configured",
          hint: kvBindingHint(),
        },
        503
      );
    }

    if (request.method === "GET") {
      if (!sessionId) {
        return jsonResponse({ exists: false, msg: "Missing sessionId" }, 400);
      }
      const value = await kv.get(sessionId);

      let data = null;
      if (value) {
        try {
          data = JSON.parse(value);
        } catch {
          data = null;
        }
      }
      return jsonResponse(
        {
          exists: !!value,
          data,
        },
        200,
        {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
        }
      );
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        const sid = body.sessionId || body.key;
        if (!sid || !body.data) {
          return jsonResponse(
            { success: false, msg: "Data incomplete" },
            400
          );
        }

        const skipRaw = String(env.SCAN_LOGIN_SKIP_TURNSTILE || "").toLowerCase();
        const skipTurnstile = ["1", "true", "yes"].includes(skipRaw);
        if (!skipTurnstile) {
          const tok =
            body.turnstileToken ||
            body.turnstile_token ||
            (body.data && (body.data.turnstileToken || body.data.turnstile_token));
          const vr = await verifyTurnstileWithEnv(env, tok);
          if (!vr.ok) {
            return jsonResponse(
              {
                success: false,
                msg: vr.error || "Turnstile verification failed",
                detail: vr.detail || null,
              },
              vr.httpStatus || 403
            );
          }
        }

        const data =
          body.data && typeof body.data === "object"
            ? {
                ...body.data,
                turnstileVerified: true,
                scanned: body.data.scanned !== false,
              }
            : body.data;

        await kv.put(sid, JSON.stringify(data), {
          expirationTtl: 300,
        });
        return jsonResponse({ success: true });
      } catch {
        return jsonResponse({ success: false, msg: "Invalid JSON" }, 400);
      }
    }

    return jsonResponse({ error: "Method Not Allowed" }, 405);
  } catch (err) {
    console.error("scan-login:", err);
    return jsonResponse(
      { exists: false, success: false, msg: String(err.message || err) },
      500
    );
  }
}
