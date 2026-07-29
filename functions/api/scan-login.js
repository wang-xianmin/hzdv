import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 扫码登录 API：GET /api/scan-login?sessionId=xxx
 * POST：写入/合并会话（手机扫码、电脑端回写 pcStatus 等）。
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

function getQuerySessionId(url) {
  const p = url.searchParams;
  return (
    p.get("sessionId") ||
    p.get("sessionid") ||
    p.get("key") ||
    p.get("Key")
  );
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
        if (!sid || !body.data || typeof body.data !== "object") {
          return jsonResponse(
            { success: false, msg: "Data incomplete" },
            400
          );
        }

        let prev = {};
        try {
          const raw = await kv.get(sid);
          if (raw) {
            const j = JSON.parse(raw);
            if (j && typeof j === "object") prev = j;
          }
        } catch (e) {
          prev = {};
        }

        const incoming = body.data;
        const data = {
          ...prev,
          ...incoming,
          scanned:
            incoming.scanned !== undefined
              ? !!incoming.scanned
              : !!prev.scanned,
          mobileConfirmed:
            incoming.mobileConfirmed !== undefined
              ? !!incoming.mobileConfirmed
              : !!prev.mobileConfirmed,
        };

        await kv.put(sid, JSON.stringify(data), {
          expirationTtl: 600,
        });
        return jsonResponse({ success: true, data });
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
