/**
 * OpenAI 兼容 Chat Completions（fetch）
 * 供分类器、试通、后续 /api/chat 共用。
 */

export function resolveApiKey(env, apiKeyEnv) {
  const name = String(apiKeyEnv || "").trim();
  if (!name) return "";
  return String((env && env[name]) || "").trim();
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * OpenAI 兼容根路径：去掉误填的 /chat/completions，并补上 /v1。
 * llm-proxy 只挂 POST /v1/chat/completions；缺 /v1 会直接 HTTP 404。
 */
export function normalizeOpenAiCompatBase(baseUrl) {
  let u = normalizeBaseUrl(baseUrl);
  if (!u) return "";
  u = u.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(u)) u += "/v1";
  return u;
}

/**
 * 若配置了 LLM_PROXY_SERVICE_URL + LLM_PROXY_API_KEY，
 * 云端生成经 VPS 长超时转发（意图分类器仍直连 INTENT_*）。
 * @returns {{ baseUrl: string, apiKey: string } | null}
 */
export function llmProxyConfig(env) {
  const baseUrl = normalizeOpenAiCompatBase(env && env.LLM_PROXY_SERVICE_URL);
  const apiKey = String((env && env.LLM_PROXY_API_KEY) || "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

function stringifyErr(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    if (typeof v === "object") {
      if (typeof v.message === "string" && v.message) return v.message;
      if (typeof v.msg === "string" && v.msg) return v.msg;
      if (typeof v.code === "string" && v.code) {
        return v.code + (v.message ? ": " + v.message : "");
      }
      return JSON.stringify(v).slice(0, 400);
    }
  } catch (e) {}
  return String(v);
}

/** 从上游 JSON 抽出可读错误（兼容 OpenAI / 阿里云百炼 / 方舟） */
export function extractUpstreamError(data, httpStatus) {
  if (!data || typeof data !== "object") {
    return httpStatus ? "HTTP " + httpStatus : "";
  }
  const candidates = [
    data.error && data.error.message,
    data.error && typeof data.error === "string" ? data.error : null,
    data.detail,
    data.message,
    data.msg,
    data.error_msg,
    data.code && data.message ? data.code + ": " + data.message : null,
    data.code,
  ];
  for (const c of candidates) {
    const s = stringifyErr(c);
    if (s && s !== "{}" && s !== "[object Object]") return s;
  }
  if (data.raw) return String(data.raw).slice(0, 400);
  if (httpStatus) return "HTTP " + httpStatus;
  return "";
}

/**
 * 阿里云等可能 HTTP 200 但 body 带 code/message 表示失败
 */
function looksLikeBusinessError(data) {
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data.choices) && data.choices.length) return false;
  const code = data.code != null ? String(data.code) : "";
  if (!code) return false;
  if (code === "0" || code === "Success" || code === "success") return false;
  return true;
}

/**
 * @returns {Promise<{ ok: boolean, status: number, data: any, latencyMs: number, error?: string }>}
 */
export async function chatCompletions({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.2,
  max_tokens = 256,
  timeoutMs = 45000,
  extraBody = null,
  /** 经 VPS llm-proxy 时：真实云端 baseUrl */
  upstreamBaseUrl = null,
  /** 经 VPS llm-proxy 时：真实云端 API Key */
  upstreamApiKey = null,
}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, status: 0, data: null, latencyMs: 0, error: "缺少 baseUrl" };
  }
  if (!apiKey) {
    return { ok: false, status: 0, data: null, latencyMs: 0, error: "缺少 API Key" };
  }
  if (!model) {
    return { ok: false, status: 0, data: null, latencyMs: 0, error: "缺少 model" };
  }

  const viaProxy = !!(upstreamBaseUrl && upstreamApiKey);
  if (viaProxy) {
    const up = normalizeBaseUrl(upstreamBaseUrl);
    if (!up) {
      return {
        ok: false,
        status: 0,
        data: null,
        latencyMs: 0,
        error: "缺少 upstreamBaseUrl",
      };
    }
  }

  // base 已是 …/v1（或上游兼容根）；禁止再拼出 …/v1/chat/completions/chat/completions
  const url = /\/chat\/completions$/i.test(base)
    ? base
    : base + "/chat/completions";
  const started = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  if (ctrl && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }

  try {
    const headers = {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    };
    if (viaProxy) {
      headers["X-Upstream-Base-Url"] = normalizeBaseUrl(upstreamBaseUrl);
      headers["X-Upstream-Api-Key"] = String(upstreamApiKey);
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: messages || [{ role: "user", content: "ping" }],
        temperature,
        max_tokens,
        ...(extraBody || {}),
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const latencyMs = Date.now() - started;
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: String(text).slice(0, 800) };
    }
    if (!res.ok) {
      let err = extractUpstreamError(data, res.status) || "HTTP " + res.status;
      try {
        const path = new URL(url).pathname;
        if (res.status === 404) {
          err += " @ " + path;
          if (/\/chat\/completions\/chat\/completions$/i.test(path)) {
            err +=
              "（基址勿含 /chat/completions，应类似 https://intent.hzdv.net/v1）";
          } else if (path === "/chat/completions") {
            err += "（基址须带 /v1，如 https://llm.hzdv.net/v1）";
          }
        } else if (
          res.status === 401 &&
          /invalid api key|unauthorized/i.test(err)
        ) {
          err += " · 与 VPS 服务密钥不一致？";
        }
      } catch (e) {}
      return {
        ok: false,
        status: res.status,
        data,
        latencyMs,
        error: err,
      };
    }
    if (looksLikeBusinessError(data)) {
      return {
        ok: false,
        status: res.status,
        data,
        latencyMs,
        error: extractUpstreamError(data, res.status) || "上游业务错误",
      };
    }
    return { ok: true, status: res.status, data, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const msg = e && e.name === "AbortError" ? "请求超时" : String((e && e.message) || e);
    return { ok: false, status: 0, data: null, latencyMs, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function extractAssistantText(data) {
  try {
    const c = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!c) {
      // 少数兼容实现用 choices[0].text
      const t0 = data && data.choices && data.choices[0] && data.choices[0].text;
      return t0 != null ? String(t0) : "";
    }
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) {
      return c.content
        .map((p) => {
          if (typeof p === "string") return p;
          if (!p) return "";
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          return "";
        })
        .join("");
    }
    if (c.content == null && typeof c.reasoning_content === "string") {
      return c.reasoning_content;
    }
    return c.content != null ? String(c.content) : "";
  } catch (e) {
    return "";
  }
}

/**
 * OpenAI 兼容流式 chat/completions。
 * onDelta(fullTextSoFar, piece) 每有新 token 调用；返回最终全文。
 */
export async function chatCompletionsStream({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.2,
  max_tokens = 512,
  timeoutMs = 60000,
  onDelta = null,
}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, status: 0, text: "", error: "缺少 baseUrl" };
  }
  if (!apiKey) {
    return { ok: false, status: 0, text: "", error: "缺少 API Key" };
  }
  if (!model) {
    return { ok: false, status: 0, text: "", error: "缺少 model" };
  }

  const url = /\/chat\/completions$/i.test(base)
    ? base
    : base + "/chat/completions";
  const started = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  if (ctrl && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages: messages || [],
        temperature,
        max_tokens,
        stream: true,
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = { raw: String(text).slice(0, 800) };
      }
      return {
        ok: false,
        status: res.status,
        text: "",
        latencyMs: Date.now() - started,
        error: extractUpstreamError(data, res.status) || "HTTP " + res.status,
      };
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      // 少数网关忽略 stream：退回整包
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        return {
          ok: false,
          status: res.status,
          text: "",
          latencyMs: Date.now() - started,
          error: "非流式响应无法解析",
        };
      }
      const full = extractAssistantText(data).trim();
      if (onDelta && full) onDelta(full, full);
      return {
        ok: !!full,
        status: res.status,
        text: full,
        latencyMs: Date.now() - started,
        error: full ? undefined : "empty",
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const rawLine of parts) {
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch (e) {
          continue;
        }
        const delta =
          obj &&
          obj.choices &&
          obj.choices[0] &&
          obj.choices[0].delta &&
          obj.choices[0].delta.content;
        if (delta == null || delta === "") continue;
        const piece = String(delta);
        full += piece;
        if (typeof onDelta === "function") onDelta(full, piece);
      }
    }

    return {
      ok: !!String(full).trim(),
      status: res.status,
      text: String(full).trim(),
      latencyMs: Date.now() - started,
      error: String(full).trim() ? undefined : "empty stream",
    };
  } catch (e) {
    const msg =
      e && e.name === "AbortError" ? "请求超时" : String((e && e.message) || e);
    return {
      ok: false,
      status: 0,
      text: "",
      latencyMs: Date.now() - started,
      error: msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
