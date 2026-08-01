/**
 * POST /api/llm-recover-log
 * 失败恢复打点：极短请求，仅确认收到（暂不落库）。
 * Body: { phone, reason?, phase?, status?, messageSnippet? }
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  try {
    await assertAnyLoginAccess(env, body.phone || "");
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  // 最小版：鉴权通过即记成功（后续可接 D1/Logpush）
  return jsonResponse({
    success: true,
    phase: "recover-log",
    received: {
      reason: String(body.reason || "").slice(0, 200),
      phase: String(body.phase || "").slice(0, 40),
      status: body.status != null ? Number(body.status) || 0 : 0,
    },
  });
}
