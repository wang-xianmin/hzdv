/**
 * Tavily 网页搜索（Cloudflare Pages → api.tavily.com）
 *
 * 环境变量：
 *   TAVILY_API_KEY   必填才启用
 *   TAVILY_MAX_RESULTS / TAVILY_SEARCH_DEPTH  可选 env 兜底；
 *   优先使用请求里 systemSettings.tavilyMaxResults / tavilySearchDepth（系统设置）
 */

export function tavilyConfigured(env) {
  return !!String((env && env.TAVILY_API_KEY) || "").trim();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * 粗判是否需要联网（分类器失败或未配置时的兜底；分类器也可标 web）
 */
export function heuristicNeedsWeb(message) {
  const s = String(message || "");
  if (s.length < 2) return false;
  // 明显不需要
  if (/^(你好|您好|嗨|hi|hello|hey)[\s!！.。]*$/i.test(s.trim())) return false;
  return /最新|今天|昨日|本周|本月|实时|新闻|股价|行情|天气|搜一下|搜索|网上|查一下|官网|发布了吗|几号比赛|谁赢了|汇率|当前|现在多少|202[4-9]年|latest|today|tonight|this week|breaking|news|stock price|weather|search the web|look up|who won|current |as of /i.test(
    s
  );
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   query: string,
 *   answer?: string,
 *   results: Array<{ title: string, url: string, content: string, score?: number }>,
 *   latencyMs: number,
 *   error?: string,
 * }>}
 */
export async function searchTavily(env, query, opts) {
  const apiKey = String((env && env.TAVILY_API_KEY) || "").trim();
  const q = String(query || "").trim().slice(0, 400);
  if (!apiKey) {
    return {
      ok: false,
      query: q,
      results: [],
      latencyMs: 0,
      error: "TAVILY_API_KEY 未配置",
    };
  }
  if (!q) {
    return { ok: false, query: "", results: [], latencyMs: 0, error: "empty query" };
  }

  const maxResults = clampInt(
    (opts && opts.maxResults) || env.TAVILY_MAX_RESULTS,
    1,
    10,
    5
  );
  const depthRaw = String(
    (opts && opts.searchDepth) || env.TAVILY_SEARCH_DEPTH || "basic"
  )
    .trim()
    .toLowerCase();
  const searchDepth = depthRaw === "advanced" ? "advanced" : "basic";

  const started = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        query: q,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        topic: "general",
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const latencyMs = Date.now() - started;
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      return {
        ok: false,
        query: q,
        results: [],
        latencyMs,
        error: "Tavily 返回非 JSON",
      };
    }
    if (!res.ok) {
      const err =
        (data && (data.detail || data.error || data.message)) ||
        "HTTP " + res.status;
      return {
        ok: false,
        query: q,
        results: [],
        latencyMs,
        error: String(err),
      };
    }
    const raw = Array.isArray(data && data.results) ? data.results : [];
    const results = raw.slice(0, maxResults).map((r) => ({
      title: String((r && r.title) || "").slice(0, 200),
      url: String((r && r.url) || "").slice(0, 500),
      content: String((r && r.content) || "").slice(0, 1200),
      score: typeof (r && r.score) === "number" ? r.score : undefined,
    }));
    return {
      ok: results.length > 0,
      query: q,
      answer: data && data.answer ? String(data.answer).slice(0, 2000) : "",
      results,
      latencyMs,
      error: results.length ? undefined : "无搜索结果",
    };
  } catch (e) {
    const msg =
      e && e.name === "AbortError"
        ? "Tavily 超时"
        : String((e && e.message) || e);
    return {
      ok: false,
      query: q,
      results: [],
      latencyMs: Date.now() - started,
      error: msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 拼进 system / user 的检索材料（控制长度） */
export function formatWebContext(pack, replyLang) {
  if (!pack || !pack.results || !pack.results.length) return "";
  const lines = [];
  const en = replyLang === "en";
  lines.push(
    en
      ? "Web search results (via Tavily). Use them when relevant; cite URLs. If results conflict or are thin, say so."
      : "以下为联网检索结果（Tavily）。相关时请引用；若材料不足或互相矛盾请说明。"
  );
  lines.push("Query: " + (pack.query || ""));
  pack.results.forEach((r, i) => {
    lines.push(
      "[" +
        (i + 1) +
        "] " +
        (r.title || "(untitled)") +
        "\nURL: " +
        (r.url || "") +
        "\n" +
        (r.content || "")
    );
  });
  const text = lines.join("\n\n");
  return text.length > 9000 ? text.slice(0, 9000) + "\n…" : text;
}
