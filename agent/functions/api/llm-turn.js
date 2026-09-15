/**
 * GET /api/llm-turn?turnId=xxx
 * 查询 SSE 生成回合进度（断线后续看 partialReply / done 结果）
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
  const phone = url.searchParams.get("phone") || "";

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
    return jsonResponse({ success: false, error: "回合不存在或已过期", exists: false }, 404);
  }

  return jsonResponse({
    success: true,
    exists: true,
    turn: publicTurnView(turn),
  });
}
