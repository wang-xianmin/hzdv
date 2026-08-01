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
 * 把口语/中文问法改成更适合 Tavily 的检索式；站点类问题可带 include_domains。
 * rules：运维维护的 KV 规则（优先）；无匹配时用内置兜底。
 * @returns {{ query: string, includeDomains: string[]|null, timeRange: string|null, refined: boolean, hint: string }}
 */
export function refineWebQuery(message, rules) {
  const s = String(message || "").trim();
  if (!s) {
    return {
      query: "",
      includeDomains: null,
      timeRange: null,
      refined: false,
      hint: "",
    };
  }

  const lower = s.toLowerCase();
  const list = Array.isArray(rules) ? rules : [];
  const enabled = list
    .filter((r) => r && r.enabled !== false && Array.isArray(r.keywords) && r.query)
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const r of enabled) {
    let hit = "";
    for (const kw of r.keywords) {
      const k = String(kw || "").trim();
      if (!k) continue;
      if (lower.indexOf(k.toLowerCase()) >= 0) {
        hit = k;
        break;
      }
    }
    if (!hit) continue;
    const domains =
      Array.isArray(r.includeDomains) && r.includeDomains.length
        ? r.includeDomains
        : null;
    return {
      query: String(r.query).slice(0, 400),
      includeDomains: domains,
      timeRange: r.timeRange || null,
      refined: true,
      hint: "rule:" + (r.label || r.id || hit),
    };
  }

  // 内置兜底（KV 尚未配置或未命中时）
  if (
    /hacker\s*news|\bhackernews\b|\bhn\b|黑客新闻|新闻黑客/i.test(s) ||
    /news\.ycombinator\.com/i.test(s)
  ) {
    return {
      query: "Hacker News front page top stories today",
      includeDomains: ["news.ycombinator.com"],
      timeRange: "day",
      refined: true,
      hint: "builtin:HN",
    };
  }

  if (
    /(今天|今日|最新).*(科技|技术|IT|互联网).*(新闻|资讯|热点|头条)/i.test(s) ||
    /(科技|技术).*(新闻|资讯).*(今天|今日|最新)/i.test(s)
  ) {
    return {
      query: "top technology news today",
      includeDomains: null,
      timeRange: "day",
      refined: true,
      hint: "builtin:tech-news",
    };
  }

  return {
    query: s.slice(0, 400),
    includeDomains: null,
    timeRange: /今天|今日|最新|实时|today|latest|breaking/i.test(s)
      ? "day"
      : null,
    refined: false,
    hint: "",
  };
}

function wantsHnSource(refined, message) {
  const domains = (refined && refined.includeDomains) || [];
  if (domains.some((d) => /ycombinator|news\.ycombinator/i.test(String(d)))) {
    return true;
  }
  const hint = String((refined && refined.hint) || "");
  if (/HN|Hacker News/i.test(hint)) return true;
  return /hacker\s*news|\bhackernews\b|\bhn\b|黑客新闻|news\.ycombinator\.com/i.test(
    String(message || "")
  );
}

/**
 * Hacker News 官方 Firebase API（比 Tavily 抓 HN 首页靠谱得多）
 */
export async function fetchHnTopStories(opts) {
  const maxResults = clampInt((opts && opts.maxResults) || 8, 1, 15, 8);
  const timeoutMs = clampInt((opts && opts.timeoutMs) || 10000, 3000, 20000, 10000);
  const started = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  try {
    const topRes = await fetch(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
      { signal: ctrl ? ctrl.signal : undefined }
    );
    if (!topRes.ok) {
      return {
        ok: false,
        query: "HN topstories",
        results: [],
        latencyMs: Date.now() - started,
        error: "HN API HTTP " + topRes.status,
        source: "hn",
      };
    }
    const ids = await topRes.json();
    if (!Array.isArray(ids) || !ids.length) {
      return {
        ok: false,
        query: "HN topstories",
        results: [],
        latencyMs: Date.now() - started,
        error: "HN topstories empty",
        source: "hn",
      };
    }
    const slice = ids.slice(0, maxResults);
    const items = await Promise.all(
      slice.map(async (id) => {
        try {
          const r = await fetch(
            "https://hacker-news.firebaseio.com/v0/item/" + id + ".json",
            { signal: ctrl ? ctrl.signal : undefined }
          );
          if (!r.ok) return null;
          return await r.json();
        } catch (e) {
          return null;
        }
      })
    );
    const results = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      if (it.dead || it.deleted) continue;
      const id = it.id;
      const title = String(it.title || "").trim();
      if (!title) continue;
      const url =
        String(it.url || "").trim() ||
        "https://news.ycombinator.com/item?id=" + id;
      const hnUrl = "https://news.ycombinator.com/item?id=" + id;
      results.push({
        title: title.slice(0, 300),
        url: url.slice(0, 500),
        content: (
          "points=" +
          (it.score != null ? it.score : "?") +
          "; by=" +
          (it.by || "?") +
          "; comments=" +
          (it.descendants != null ? it.descendants : "?") +
          "; hn=" +
          hnUrl
        ).slice(0, 500),
        score: typeof it.score === "number" ? it.score : undefined,
      });
    }
    return {
      ok: results.length > 0,
      query: "HN Firebase topstories",
      results,
      latencyMs: Date.now() - started,
      error: results.length ? undefined : "HN items empty",
      source: "hn",
    };
  } catch (e) {
    const msg =
      e && e.name === "AbortError"
        ? "HN API 超时"
        : String((e && e.message) || e);
    return {
      ok: false,
      query: "HN topstories",
      results: [],
      latencyMs: Date.now() - started,
      error: msg,
      source: "hn",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const refined =
    opts && opts.skipRefine
      ? {
          query: String(query || "").trim().slice(0, 400),
          includeDomains: (opts && opts.includeDomains) || null,
          timeRange: (opts && opts.timeRange) || null,
          refined: false,
          hint: "",
        }
      : refineWebQuery(query, (opts && opts.rules) || null);
  const q = String(
    (opts && opts.queryOverride) || refined.query || query || ""
  )
    .trim()
    .slice(0, 400);
  const includeDomains =
    (opts && opts.includeDomains) || refined.includeDomains || null;
  const timeRange = (opts && opts.timeRange) || refined.timeRange || null;

  const maxResults = clampInt(
    (opts && opts.maxResults) || env.TAVILY_MAX_RESULTS,
    1,
    10,
    5
  );

  // HN：走官方 API，避免 Tavily 摘要噪声导致模型乱编
  if (wantsHnSource(refined, query)) {
    const hn = await fetchHnTopStories({
      maxResults: Math.min(Math.max(maxResults, 8), 12),
      timeoutMs: (opts && opts.timeoutMs) || 10000,
    });
    if (hn.ok) {
      return {
        ...hn,
        refine: Object.assign({}, refined, {
          refined: true,
          hint: (refined.hint || "HN") + "+api",
        }),
      };
    }
    // HN API 失败再回落 Tavily
  }

  if (!apiKey) {
    return {
      ok: false,
      query: q,
      results: [],
      latencyMs: 0,
      error: "TAVILY_API_KEY 未配置",
      refine: refined,
    };
  }
  if (!q) {
    return {
      ok: false,
      query: "",
      results: [],
      latencyMs: 0,
      error: "empty query",
      refine: refined,
    };
  }

  const depthRaw = String(
    (opts && opts.searchDepth) || env.TAVILY_SEARCH_DEPTH || "basic"
  )
    .trim()
    .toLowerCase();
  const searchDepth = depthRaw === "advanced" ? "advanced" : "basic";

  const started = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl
    ? setTimeout(
        () => ctrl.abort(),
        clampInt((opts && opts.timeoutMs) || 8000, 3000, 20000, 8000)
      )
    : null;

  try {
    const body = {
      query: q,
      search_depth: searchDepth,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      topic: "general",
    };
    if (Array.isArray(includeDomains) && includeDomains.length) {
      body.include_domains = includeDomains.slice(0, 10);
    }
    if (timeRange && /^(day|week|month|year)$/i.test(String(timeRange))) {
      body.time_range = String(timeRange).toLowerCase();
    }

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
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
        refine: refined,
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
        refine: refined,
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
      refine: refined,
      source: "tavily",
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
      refine: refined,
      source: "tavily",
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
  const via = pack.source === "hn" ? "Hacker News API" : "Tavily";
  lines.push(
    en
      ? "CURRENT materials (via " +
        via +
        "). These ARE the latest/front-page items to report. Copy each title and URL verbatim. Do not say materials are empty."
      : "【当前联网材料·来源：" +
        via +
        "】下列即为最新/首页热门条目，请逐条汇报。标题与 URL 逐字复制。禁止说材料为空或没有今天的新闻。"
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
