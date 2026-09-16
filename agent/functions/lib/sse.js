/**
 * SSE 工具（借鉴 Cloudflare Agents SDK：长连接 + comment keepalive 防边缘空闲掐断）
 * keepalive 约 25s（WHATWG 建议 ~15s；Agents 用 25s 避开 idle watchdog）
 *
 * 默认 abortOnCancel=false：客户端断开后仍继续 handler（配合 waitUntil 后台写完 KV）。
 * 返回 { response, finished }，finished 在 handler 结束后 resolve。
 */

export const SSE_KEEPALIVE_INTERVAL_MS = 25000;
export const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

export function sseHeaders(extra) {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(extra || {}),
  };
}

export function encodeSseEvent(event, data, id) {
  const lines = [];
  if (id != null && id !== "") lines.push("id: " + String(id));
  if (event) lines.push("event: " + String(event));
  const payload =
    typeof data === "string" ? data : JSON.stringify(data == null ? null : data);
  String(payload)
    .split(/\n/)
    .forEach(function (line) {
      lines.push("data: " + line);
    });
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

/**
 * 创建 SSE Response。
 * api: { send, comment, close, signal, clientGone() }
 * @returns {{ response: Response, finished: Promise<void> }}
 */
export function createSseResponse(handler, opts) {
  const encoder = new TextEncoder();
  let keepaliveTimer = null;
  let closed = false;
  let clientGone = false;
  let eventSeq = 0;
  const abortOnCancel = !!(opts && opts.abortOnCancel);
  const abort =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  let finishedResolve;
  const finished = new Promise(function (resolve) {
    finishedResolve = resolve;
  });

  const stream = new ReadableStream({
    async start(controller) {
      function writeRaw(text) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch (e) {
          closed = true;
          clientGone = true;
        }
      }

      function armKeepalive() {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(function () {
          writeRaw(SSE_KEEPALIVE_FRAME);
        }, (opts && opts.keepaliveMs) || SSE_KEEPALIVE_INTERVAL_MS);
      }

      function disarmKeepalive() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }

      const api = {
        signal: abort ? abort.signal : null,
        clientGone: function () {
          return clientGone;
        },
        send: function (event, data, id) {
          if (closed) return;
          eventSeq += 1;
          const eid = id != null ? id : String(eventSeq);
          writeRaw(encodeSseEvent(event || "message", data, eid));
        },
        comment: function (text) {
          writeRaw(": " + String(text || "ping") + "\n\n");
        },
        close: function () {
          if (closed) return;
          closed = true;
          disarmKeepalive();
          try {
            controller.close();
          } catch (e) {}
        },
      };

      armKeepalive();
      try {
        await handler(api);
      } catch (err) {
        try {
          api.send("error", {
            error: String((err && err.message) || err || "stream failed"),
          });
        } catch (e2) {}
      } finally {
        api.close();
        if (finishedResolve) finishedResolve();
      }
    },
    cancel: function () {
      clientGone = true;
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (opts && typeof opts.onDisconnect === "function") {
        try {
          opts.onDisconnect();
        } catch (e) {}
      }
      if (abortOnCancel && abort) abort.abort();
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: sseHeaders(opts && opts.headers),
    }),
    finished: finished,
  };
}
