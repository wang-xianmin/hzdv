/**
 * GET /api/llm-turn?turnId=xxx&phone=xxx
 * 查询 SSE/WS 生成回合进度（断线后轮询 partialReply / done 结果）
 */
import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import { loadAgentTurn, publicTurnView } from "../lib/agent-turn-store.js";

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
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const url = new URL(request.url);
  const turnId =
    url.searchParams.get("turnId") ||
    url.searchParams.get("id") ||
    "";
  const phone = String(url.searchParams.get("phone") || "").trim();

  try {
    await assertAnyLoginAccess(env, phone);
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  if (!String(turnId).trim()) {
    return jsonResponse({ success: false, error: "缺少 turnId" }, 400);
  }

  const turn = await loadAgentTurn(env, turnId);
  if (!turn) {
    return jsonResponse(
      { success: false, error: "回合不存在或已过期", exists: false },
      404
    );
  }

  const owner = String(turn.phone || "").trim();
  if (owner && phone && owner !== phone) {
    return jsonResponse({ success: false, error: "无权查看该回合" }, 403);
  }

  return jsonResponse({
    success: true,
    exists: true,
    turn: publicTurnView(turn),
  });
}
