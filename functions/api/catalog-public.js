/**
 * 产品目录公开读（主展区 / Agent 检索）
 *
 * GET /api/catalog-public?id=           单条（仅启用）
 * GET /api/catalog-public?kind=solution  列表（仅启用）
 * GET /api/catalog-public?browse=1       浏览列表（D1，不走向量）
 * GET /api/catalog-public?q=&kind=&topK=  向量检索 + 条目详情；无命中/失败时对「有什么产品」类问句回退 D1 列表
 *
 * 若存在人工纠错回灌的黄金答（Vectorize source=qa_gold），优先返回 mode=qa_gold。
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding } from "../lib/cloudflare-bindings.js";
import {
  catalogItemPublicView,
  getCatalogItem,
  listCatalogItems,
} from "../lib/catalog-d1.js";
import {
  queryCatalogVectors,
  queryQaGoldVectors,
} from "../lib/catalog-vectorize.js";
import { getQaGold } from "../lib/agent-qa-d1.js";
import {
  isBrowseCatalogQuery,
  detectCatalogKind,
} from "../lib/catalog-query-intent.js";
import { getCatalogSynonymMap } from "../lib/catalog-synonyms.js";

/** 黄金问答命中阈值（cosine；越高越严） */
const QA_GOLD_SCORE_MIN = 0.72;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** catalog_items 尚无 service kind：检索过滤时忽略 */
function catalogFilterKind(kind) {
  if (!kind || kind === "service") return null;
  return kind;
}

async function listActivePublic(d1, kind, limit) {
  let items = await listCatalogItems(d1, { includeInactive: false });
  const fk = catalogFilterKind(kind);
  if (fk) {
    items = items.filter((x) => x.kind === fk);
  }
  const lim = Math.min(20, Math.max(1, Number(limit) || 10));
  return items.slice(0, lim).map(catalogItemPublicView);
}

async function tryQaGold(env, d1, q) {
  try {
    const result = await queryQaGoldVectors(env, q, { topK: 3 });
    const matches = result.matches || [];
    let best = null;
    for (const m of matches) {
      const md = m.metadata || {};
      if (Number(md.is_active) === 0) continue;
      const goldId = String(md.gold_id || "").trim();
      if (!goldId) continue;
      if (best == null || (m.score || 0) > (best.score || 0)) {
        best = { score: m.score, goldId, md };
      }
    }
    if (!best || (best.score || 0) < QA_GOLD_SCORE_MIN) return null;
    const gold = await getQaGold(d1, best.goldId);
    if (!gold || !gold.is_active) return null;

    const items = [];
    for (const itemId of gold.bind_item_ids || []) {
      const row = await getCatalogItem(d1, itemId);
      if (!row || Number(row.is_active) === 0) continue;
      items.push(catalogItemPublicView(row));
    }

    return {
      success: true,
      query: q,
      mode: "qa_gold",
      model: result.model,
      score: best.score,
      gold: {
        id: gold.id,
        category: gold.category,
        answer_kind: gold.answer_kind,
        reply_text: gold.reply_text || "",
        bind_item_ids: gold.bind_item_ids || [],
      },
      items,
    };
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const d1 = pickD1Binding(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }
  try {
    await ensureAllD1Tables(d1);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 500);
  }

  const url = new URL(request.url);
  const id = String(url.searchParams.get("id") || "").trim();
  const q = String(
    url.searchParams.get("q") || url.searchParams.get("query") || ""
  ).trim();
  let kind = String(url.searchParams.get("kind") || "").trim() || null;
  const topK = Math.min(
    20,
    Math.max(1, Number(url.searchParams.get("topK")) || 5)
  );
  const browse =
    url.searchParams.get("browse") === "1" ||
    url.searchParams.get("mode") === "browse";
  const skipGold = url.searchParams.get("skip_gold") === "1";

  if (url.searchParams.get("synonyms") === "1") {
    try {
      const map = await getCatalogSynonymMap(d1);
      return jsonResponse({ success: true, synonyms: map });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e.message || e) }, 500);
    }
  }

  let synonymMap = null;
  try {
    synonymMap = await getCatalogSynonymMap(d1);
  } catch (e) {
    synonymMap = null;
  }

  // 未显式传 kind 时，从问句推断（问「产品」则不混入方案/案例）
  if (!kind && q) {
    kind = detectCatalogKind(q, synonymMap);
  }

  if (id) {
    const item = await getCatalogItem(d1, id);
    if (!item || Number(item.is_active) === 0) {
      return jsonResponse({ success: false, error: "未找到" }, 404);
    }
    return jsonResponse({ success: true, item: catalogItemPublicView(item) });
  }

  // 自然语言问：先查人工纠错标准答
  if (q && !browse && !skipGold) {
    const goldHit = await tryQaGold(env, d1, q);
    if (goldHit) return jsonResponse(goldHit);
  }

  const filterKind = catalogFilterKind(kind);

  // 浏览模式：直接 D1 列表（「你们有什么产品」）
  if (browse) {
    const items = await listActivePublic(d1, filterKind, topK);
    return jsonResponse({
      success: true,
      mode: "browse",
      items,
    });
  }

  if (q) {
    const wantBrowse = isBrowseCatalogQuery(q, synonymMap);
    // 泛问：优先尝试向量；空/失败则 D1 列表，避免空手
    if (wantBrowse) {
      try {
        const result = await queryCatalogVectors(env, q, {
          topK,
          kind: filterKind,
        });
        const seen = new Set();
        const ranked = [];
        for (const m of result.matches || []) {
          const md = m.metadata || {};
          const itemId = String(md.item_id || "").trim();
          if (!itemId || seen.has(itemId)) continue;
          if (Number(md.is_active) === 0) continue;
          if (filterKind && md.kind !== filterKind) continue;
          seen.add(itemId);
          const row = await getCatalogItem(d1, itemId);
          if (!row || Number(row.is_active) === 0) continue;
          ranked.push({ score: m.score, ...catalogItemPublicView(row) });
        }
        if (ranked.length) {
          return jsonResponse({
            success: true,
            query: q,
            mode: "vector",
            model: result.model,
            items: ranked,
          });
        }
      } catch (e) {
        // fall through to D1 browse
      }
      const items = await listActivePublic(d1, filterKind, topK);
      return jsonResponse({
        success: true,
        query: q,
        mode: "browse_fallback",
        items,
      });
    }

    try {
      const result = await queryCatalogVectors(env, q, {
        topK,
        kind: filterKind,
      });
      const seen = new Set();
      const items = [];
      for (const m of result.matches || []) {
        const md = m.metadata || {};
        const itemId = String(md.item_id || "").trim();
        if (!itemId || seen.has(itemId)) continue;
        if (Number(md.is_active) === 0) continue;
        if (filterKind && md.kind !== filterKind) continue;
        seen.add(itemId);
        const row = await getCatalogItem(d1, itemId);
        if (!row || Number(row.is_active) === 0) continue;
        items.push({
          score: m.score,
          ...catalogItemPublicView(row),
        });
      }
      return jsonResponse({
        success: true,
        query: q,
        mode: "vector",
        model: result.model,
        items,
      });
    } catch (e) {
      return jsonResponse({
        success: false,
        error: String(e.message || e),
        items: [],
      });
    }
  }

  const items = await listActivePublic(d1, filterKind, topK);
  return jsonResponse({
    success: true,
    mode: "browse",
    items,
  });
}
