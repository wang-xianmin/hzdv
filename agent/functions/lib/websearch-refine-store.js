/**
 * 联网检索改写规则（KV）
 * 匹配用户消息中的关键词 → 英文 query + include_domains + time_range
 * 供超级用户 / 技术员在运维菜单维护。
 */

export const WEBSEARCH_REFINE_KV_KEY = "hzdv:websearch_refine_v1";

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function parseKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((k) => String(k || "").trim())
      .filter(Boolean)
      .slice(0, 40);
  }
  return String(raw || "")
    .split(/[,，\n|/]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function parseDomains(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((d) => String(d || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);
  }
  return String(raw || "")
    .split(/[,，\s\n]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeTimeRange(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  if (s === "day" || s === "week" || s === "month" || s === "year") return s;
  return "";
}

export function normalizeRefineRule(raw, orderHint) {
  const keywords = parseKeywords(raw && (raw.keywords || raw.keyword));
  const includeDomains = parseDomains(
    raw && (raw.includeDomains || raw.include_domains || raw.domains)
  );
  const order =
    Number.isFinite(Number(raw && raw.order))
      ? Number(raw.order)
      : Number.isFinite(Number(orderHint))
        ? Number(orderHint)
        : 0;
  return {
    id: String((raw && raw.id) || "").trim() || uid(),
    label: String((raw && raw.label) || "").trim().slice(0, 80) || "未命名规则",
    keywords,
    query: String((raw && raw.query) || "").trim().slice(0, 400),
    includeDomains,
    timeRange: normalizeTimeRange(raw && (raw.timeRange || raw.time_range)),
    enabled: raw && raw.enabled === false ? false : true,
    order,
  };
}

export function defaultWebsearchRefineSeed() {
  return [
    {
      label: "Hacker News",
      keywords: [
        "hacker news",
        "hackernews",
        "hn",
        "黑客新闻",
        "新闻黑客",
        "news.ycombinator.com",
      ],
      query: "Hacker News front page top stories today",
      includeDomains: ["news.ycombinator.com"],
      timeRange: "day",
    },
    {
      label: "GitHub Trending",
      keywords: ["github trending", "github热门", "github 热门", "github趋势"],
      query: "GitHub trending repositories today",
      includeDomains: ["github.com"],
      timeRange: "day",
    },
    {
      label: "Reddit",
      keywords: ["reddit", "subreddit", "红迪"],
      query: "Reddit popular posts today",
      includeDomains: ["reddit.com"],
      timeRange: "day",
    },
    {
      label: "Product Hunt",
      keywords: ["product hunt", "producthunt"],
      query: "Product Hunt top products today",
      includeDomains: ["producthunt.com"],
      timeRange: "day",
    },
    {
      label: "科技新闻（英文检索）",
      keywords: ["tech news", "科技新闻", "技术新闻", "IT新闻", "今日科技"],
      query: "top technology news today",
      includeDomains: [],
      timeRange: "day",
    },
  ].map((r, i) => normalizeRefineRule(r, i));
}

export function sortRefineRules(rules) {
  return (rules || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
}

export function reindexRefineOrders(rules) {
  return sortRefineRules(rules).map((r, i) => ({ ...r, order: i }));
}

export async function loadWebsearchRefineRules(kv) {
  if (!kv || typeof kv.get !== "function") {
    return { rules: defaultWebsearchRefineSeed(), seeded: true, updatedAt: 0 };
  }
  let raw = null;
  try {
    raw = await kv.get(WEBSEARCH_REFINE_KV_KEY, "json");
  } catch (e) {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.rules) || !raw.rules.length) {
    const rules = defaultWebsearchRefineSeed();
    try {
      await kv.put(
        WEBSEARCH_REFINE_KV_KEY,
        JSON.stringify({ rules, updatedAt: Date.now() })
      );
    } catch (e2) {}
    return { rules, seeded: true, updatedAt: Date.now() };
  }
  const rules = reindexRefineOrders(
    raw.rules.map((r, i) => normalizeRefineRule(r, i))
  );
  return {
    rules,
    seeded: false,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export async function saveWebsearchRefineRules(kv, rules) {
  const list = reindexRefineOrders(
    (rules || []).map((r, i) => normalizeRefineRule(r, i))
  ).filter((r) => r.keywords.length && r.query);
  const updatedAt = Date.now();
  await kv.put(
    WEBSEARCH_REFINE_KV_KEY,
    JSON.stringify({ rules: list, updatedAt })
  );
  return { rules: list, updatedAt };
}
