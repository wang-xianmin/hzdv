import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 扫码登录 API：GET /api/scan-login?sessionId=xxx
 * 将 sessionId 与表单数据存入 KV，POST 时 TTL 300 秒。
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


      // --- 临时调试逻辑：手机扫码时如果 KV 没数据，自动帮它写一条 ---
      // 判断是否是手机端（简单通过 UA 判断或直接未命中就写）
      // 注意：这个调试逻辑可能会干扰正常的 POST 流程，建议在测试完成后禁用
      // if (!value && request.headers.get("user-agent") && request.headers.get("user-agent").match(/Mobile|Android|iPhone|iPad|iPod/i)) {
      //   const debugData = { 
      //       email: "debug@test.com", 
      //       phone: "13800138000", 
      //       isRegistered: false // 你可以改这里测试不同分支
      //   };
      //   await kv.put(sessionId, JSON.stringify(debugData), { expirationTtl: 300 });
      //   return jsonResponse({ exists: true, data: debugData, msg: "调试：已自动写入模拟数据" });
      //    }
    // --- 调试逻辑结束 ---



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
          // 轮询接口必须禁用缓存，否则前端可能反复拿到旧结果
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
        await kv.put(sid, JSON.stringify(body.data), {
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
