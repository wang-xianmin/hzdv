/**
 * SSE 工具（借鉴 Cloudflare Agents SDK：长连接 + comment keepalive 防边缘空闲掐断）
 * keepalive 约 25s（WHATWG 建议 ~15s；Agents 用 25s 避开 ~5min idle watchdog）
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
 * 创建 SSE Response：handler(api) 内写事件；连接保持期间 Worker 墙钟无硬上限。
 * api: { send(event, data, id?), comment(text?), close(), signal }
 */
export function createSseResponse(handler, opts) {
  const encoder = new TextEncoder();
  let keepaliveTimer = null;
  let closed = false;
  let eventSeq = 0;
  const abort =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  const stream = new ReadableStream({
    async start(controller) {
      function writeRaw(text) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch (e) {
          closed = true;
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
      }
    },
    cancel: function () {
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (abort) abort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(opts && opts.headers),
  });
}
