/**
 * GET /api/llm-session  （Upgrade: websocket）
 * 轻量会话壳（无 Durable Object）：③ 生成经 WS 推送 meta/note/delta/done。
 *
 * 客户端消息：
 *   { type: "chat", ...llm-chat body 字段 }
 *   { type: "resume", turnId, phone }
 *   { type: "ping" }
 *
 * 服务端帧：{ event, data }（与 SSE 事件名对齐）
 */
import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import { clientCountryFromRequest } from "../lib/route-mode.js";
import {
  acceptWebSocketUpgrade,
  createWsEventSink,
  startWsKeepalive,
} from "../lib/ws-session.js";
import { handleLlmChat } from "./llm-chat.js";
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

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function deliverHandleResult(sink, out) {
  if (!out) return;
  if (out.transport === "ws") return;
  if (typeof Response !== "undefined" && out instanceof Response) {
    let j = null;
    try {
      j = await out.json();
    } catch (e) {
      sink.send("error", { error: "invalid response" });
      return;
    }
    if (j && j.success) sink.send("done", j);
    else {
      sink.send("error", {
        error: (j && j.error) || "request failed",
        ...(j || {}),
      });
    }
  }
}

async function resumeTurn(env, sink, turnId, phone, waitUntil) {
  const id = String(turnId || "").trim();
  const ph = String(phone || "").trim();
  if (!id) {
    sink.send("error", { error: "缺少 turnId" });
    return;
  }
  try {
    await assertAnyLoginAccess(env, ph);
  } catch (err) {
    sink.send("error", {
      error: String((err && err.message) || "auth failed"),
    });
    return;
  }

  const started = Date.now();
  const maxMs = 180000;
  let lastPartial = "";

  const work = (async function () {
    sink.send("meta", { turnId: id, via: "resume", transport: "ws" });
    while (Date.now() - started < maxMs) {
      if (sink.clientGone()) return;
      const turn = await loadAgentTurn(env, id);
      if (!turn) {
        sink.send("error", { error: "回合不存在或已过期", turnId: id });
        return;
      }
      const owner = String(turn.phone || "").trim();
      if (owner && ph && owner !== ph) {
        sink.send("error", { error: "无权查看该回合" });
        return;
      }
      const view = publicTurnView(turn);
      const partial = String(
        (view && (view.partialReply || view.reply)) || ""
      );
      if (partial && partial !== lastPartial) {
        lastPartial = partial;
        sink.send("delta", { text: partial });
      }
      if (view.status === "done") {
        sink.send("done", {
          success: true,
          reply: view.reply || view.partialReply || "",
          model: view.model || null,
          notes: view.notes || [],
          attempts: view.attempts || [],
          turnId: id,
          resumed: true,
        });
        return;
      }
      if (view.status === "error") {
        sink.send("done", {
          success: false,
          error: view.error || "生成失败",
          notes: view.notes || [],
          attempts: view.attempts || [],
          turnId: id,
          resumed: true,
        });
        return;
      }
      await sleep(1200);
    }
    sink.send("error", {
      error: "续看超时",
      turnId: id,
      partialReply: lastPartial,
    });
  })();

  if (typeof waitUntil === "function") {
    try {
      waitUntil(work);
    } catch (e) {}
  }
  await work;
}

function bindSession(context, server) {
  const { env, request } = context;
  const waitUntil =
    context && typeof context.waitUntil === "function"
      ? context.waitUntil.bind(context)
      : null;
  const sink = createWsEventSink(server);
  const stopKeepalive = startWsKeepalive(server);
  let busy = false;

  server.addEventListener("close", function () {
    sink.markGone();
    stopKeepalive();
  });
  server.addEventListener("error", function () {
    sink.markGone();
    stopKeepalive();
  });

  server.addEventListener("message", function (event) {
    const work = (async function () {
      let msg = null;
      try {
        msg =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : JSON.parse(String(event.data || ""));
      } catch (e) {
        sink.send("error", { error: "Invalid JSON" });
        return;
      }
      if (!msg || typeof msg !== "object") {
        sink.send("error", { error: "Invalid message" });
        return;
      }

      const type = String(msg.type || msg.action || "chat").toLowerCase();
      if (type === "ping") {
        sink.send("pong", { t: Date.now() });
        return;
      }

      // resume 可与后台生成并行（只读 KV）；chat 互斥
      if (type !== "resume" && busy) {
        sink.send("error", { error: "会话忙，请等待当前生成结束" });
        return;
      }

      const isChat = type !== "resume";
      if (isChat) busy = true;
      try {
        if (type === "resume") {
          await resumeTurn(
            env,
            sink,
            msg.turnId || msg.id,
            msg.phone,
            waitUntil
          );
          return;
        }

        const body = Object.assign({}, msg.body || msg, {
          stream: true,
        });
        delete body.type;
        delete body.action;
        delete body.body;

        try {
          await assertAnyLoginAccess(env, body.phone || "");
        } catch (err) {
          const res = opsAuthErrorResponse(err);
          await deliverHandleResult(sink, res);
          return;
        }

        const out = await handleLlmChat(env, body, {
          country: clientCountryFromRequest(request),
          request: request,
          waitUntil: waitUntil,
          eventSink: sink,
        });
        await deliverHandleResult(sink, out);
      } catch (e) {
        sink.send("error", {
          error: String((e && e.message) || e || "session failed"),
        });
      } finally {
        if (isChat) busy = false;
      }
    })();

    if (typeof waitUntil === "function") {
      try {
        waitUntil(work);
      } catch (e) {}
    }
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "GET" || request.method === "HEAD") {
    const upgraded = acceptWebSocketUpgrade(request);
    if (upgraded.error) {
      if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return jsonResponse({
          success: true,
          service: "llm-session",
          transport: "websocket",
          durableObject: false,
          usage: {
            connect: "wss://<host>/api/llm-session",
            chat: { type: "chat", phone: "", message: "", modelId: "auto" },
            resume: { type: "resume", turnId: "", phone: "" },
          },
        });
      }
      return upgraded.error;
    }
    bindSession(context, upgraded.server);
    return upgraded.response;
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}
