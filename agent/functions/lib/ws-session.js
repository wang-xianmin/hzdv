/**
 * 轻量 WebSocket 会话壳（无 Durable Object）
 * 协议帧：{ event, data } —— 与 SSE 的 meta|note|delta|done|error 对齐
 */

export const WS_KEEPALIVE_INTERVAL_MS = 25000;

/**
 * 把 CF WebSocket（server 端）适配成与 SSE api 相同的 eventSink。
 * api: { send(event, data), clientGone(), close(), setOnDisconnect(fn) }
 */
export function createWsEventSink(server) {
  let gone = false;
  let onDisconnect = null;

  function markGone() {
    if (gone) return;
    gone = true;
    if (typeof onDisconnect === "function") {
      try {
        onDisconnect();
      } catch (e) {}
    }
  }

  const api = {
    send: function (event, data) {
      if (gone) return;
      try {
        if (server.readyState === 1 /* OPEN */) {
          server.send(
            JSON.stringify({
              event: event || "message",
              data: data == null ? null : data,
            })
          );
        } else {
          markGone();
        }
      } catch (e) {
        markGone();
      }
    },
    clientGone: function () {
      return gone;
    },
    close: function () {
      // 生成结束不主动关 WS，便于同连接 resume / 下一轮 chat
    },
    setOnDisconnect: function (fn) {
      onDisconnect = typeof fn === "function" ? fn : null;
    },
    markGone: markGone,
  };

  return api;
}

export function startWsKeepalive(server, intervalMs) {
  const ms = intervalMs || WS_KEEPALIVE_INTERVAL_MS;
  const timer = setInterval(function () {
    try {
      if (server.readyState === 1) {
        server.send(JSON.stringify({ event: "keepalive", data: { t: Date.now() } }));
      } else {
        clearInterval(timer);
      }
    } catch (e) {
      clearInterval(timer);
    }
  }, ms);
  return function stop() {
    clearInterval(timer);
  };
}

/**
 * @returns {{ response: Response, server: WebSocket } | { error: Response }}
 */
export function acceptWebSocketUpgrade(request) {
  const upgrade = String(request.headers.get("Upgrade") || "").toLowerCase();
  if (upgrade !== "websocket") {
    return {
      error: new Response(
        JSON.stringify({
          success: false,
          error: "Expected Upgrade: websocket",
          hint: "浏览器用 WebSocket 连接本路径；③ 生成优先走 WS，失败回退 SSE",
        }),
        {
          status: 426,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Upgrade: "websocket",
          },
        }
      ),
    };
  }

  if (typeof WebSocketPair === "undefined") {
    return {
      error: new Response(
        JSON.stringify({
          success: false,
          error: "Runtime 不支持 WebSocketPair",
        }),
        {
          status: 501,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      ),
    };
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  return {
    response: new Response(null, { status: 101, webSocket: client }),
    server: server,
  };
}
