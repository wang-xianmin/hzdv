/**
 * 产品目录 → Vectorize 索引 / 试搜（运维）
 *
 * POST /api/catalog-index
 *   { phone, action: "reindex" }           全量（含停用删除）
 *   { phone, action: "reindex", id }       单条
 *   { phone, action: "query", q, topK?, kind? }  试搜
 * GET  /api/catalog-index?phone=           绑定与模型信息
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { assertCatalogOpsAccess, opsAuthErrorResponse } from "../lib/ops-auth.js";
import { pickD1Binding } from "../lib/cloudflare-bindings.js";
import { getCatalogItem, listCatalogItems } from "../lib/catalog-d1.js";
import {
  CATALOG_EMBED_DIMS,
  CATALOG_EMBED_MODEL,
  indexCatalogItems,
  pickAiBinding,
  pickVectorizeBinding,
  queryCatalogVectors,
} from "../lib/catalog-vectorize.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function phoneFromUrl(request) {
  return new URL(request.url).searchParams.get("phone") || "";
}

export async function onRequest(context) {
  const { request, env } = context;
  const d1 = pickD1Binding(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }
  try {
    await ensureAllD1Tables(d1);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 500);
  }

  if (request.method === "GET") {
    try {
      await assertCatalogOpsAccess(env, phoneFromUrl(request));
      return jsonResponse({
        success: true,
        model: CATALOG_EMBED_MODEL,
        dimensions: CATALOG_EMBED_DIMS,
        ai_bound: !!pickAiBinding(env),
        vectorize_bound: !!pickVectorizeBinding(env),
        hint:
          "Pages 绑定：Workers AI → AI；Vectorize index(hzdv-index) → VECTORIZE 或 HZDV_INDEX。维度须 768。",
      });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);

  try {
    await assertCatalogOpsAccess(env, body.phone);
    const action = String(body.action || "reindex").trim();

    if (action === "query") {
      const result = await queryCatalogVectors(env, body.q || body.query, {
        topK: body.topK,
        kind: body.kind || null,
      });
      return jsonResponse({ success: true, ...result });
    }

    if (action === "reindex") {
      let items;
      if (body.id) {
        const one = await getCatalogItem(d1, body.id);
        if (!one) {
          return jsonResponse({ success: false, error: "条目不存在" }, 404);
        }
        items = [one];
      } else {
        items = await listCatalogItems(d1, { includeInactive: true });
      }
      const result = await indexCatalogItems(env, items);
      return jsonResponse({
        success: result.errors.length === 0,
        total: items.length,
        ...result,
        error: result.errors.length ? result.errors.join("; ") : undefined,
      });
    }

    return jsonResponse({ success: false, error: "未知 action" }, 400);
  } catch (e) {
    return opsAuthErrorResponse(e);
  }
}
