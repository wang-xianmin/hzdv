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

  const url = base + "/chat/completions";
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
      },
      body: JSON.stringify({
        model,
        messages: messages || [{ role: "user", content: "ping" }],
        temperature,
        max_tokens,
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
      const errMsg =
        (data && (data.error?.message || data.message || data.error)) ||
        ("HTTP " + res.status);
      return {
        ok: false,
        status: res.status,
        data,
        latencyMs,
        error: String(errMsg),
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
    if (!c) return "";
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) {
      return c.content
        .map((p) => (typeof p === "string" ? p : p && p.text) || "")
        .join("");
    }
    return String(c.content || "");
  } catch (e) {
    return "";
  }
}
