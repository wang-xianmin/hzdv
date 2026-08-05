/**
 * 产品目录公开读（主展区 / Agent 检索）
 *
 * GET /api/catalog-public?id=           单条（仅启用）
 * GET /api/catalog-public?kind=solution  列表（仅启用）
 * GET /api/catalog-public?q=&kind=&topK=  向量检索 + 条目详情
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding } from "../lib/cloudflare-bindings.js";
import {
  catalogItemPublicView,
  getCatalogItem,
  listCatalogItems,
} from "../lib/catalog-d1.js";
import { queryCatalogVectors } from "../lib/catalog-vectorize.js";

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
  const q = String(url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  const kind = String(url.searchParams.get("kind") || "").trim() || null;
  const topK = Math.min(10, Math.max(1, Number(url.searchParams.get("topK")) || 2));

  if (id) {
    const item = await getCatalogItem(d1, id);
    if (!item || Number(item.is_active) === 0) {
      return jsonResponse({ success: false, error: "未找到" }, 404);
    }
    return jsonResponse({ success: true, item: catalogItemPublicView(item) });
  }

  if (q) {
    try {
      const result = await queryCatalogVectors(env, q, { topK, kind });
      const seen = new Set();
      const items = [];
      for (const m of result.matches || []) {
        const md = m.metadata || {};
        const itemId = String(md.item_id || "").trim();
        if (!itemId || seen.has(itemId)) continue;
        if (Number(md.is_active) === 0) continue;
        if (kind && md.kind !== kind) continue;
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

  let items = await listCatalogItems(d1, { includeInactive: false });
  if (kind) {
    items = items.filter((x) => x.kind === kind);
  }
  return jsonResponse({
    success: true,
    items: items.map(catalogItemPublicView),
  });
}
