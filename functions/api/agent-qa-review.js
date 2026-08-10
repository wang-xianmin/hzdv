/**
 * 企业问答运维：列表 / 修订 / 发布回灌 / 下架
 *
 * GET  /api/agent-qa-review?phone=&view=logs|gold&status=&category=&limit=
 * POST JSON:
 *   { phone, action: "save", id, review_status?, corrected_*? }
 *   { phone, action: "publish", id, question_canonical?, question_variants?, answer_kind? }
 *   { phone, action: "unpublish", gold_id }
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding } from "../lib/cloudflare-bindings.js";
import {
  assertCatalogOpsAccess,
  opsAuthErrorResponse,
} from "../lib/ops-auth.js";
import {
  getEnterpriseQa,
  getQaGold,
  listEnterpriseQa,
  listQaGold,
  publishQaFromReview,
  unpublishQaGold,
  updateEnterpriseQaReview,
} from "../lib/agent-qa-d1.js";
import {
  deleteQaGoldVectors,
  indexQaGold,
} from "../lib/catalog-vectorize.js";
import {
  catalogItemPublicView,
  getCatalogItem,
} from "../lib/catalog-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function phoneFromUrl(request) {
  return new URL(request.url).searchParams.get("phone") || "";
}

async function expandBindItems(d1, gold) {
  if (!gold || !Array.isArray(gold.bind_item_ids) || !gold.bind_item_ids.length) {
    return { ...gold, items: [] };
  }
  const items = [];
  for (const id of gold.bind_item_ids) {
    const row = await getCatalogItem(d1, id);
    if (row && Number(row.is_active) !== 0) {
      items.push(catalogItemPublicView(row));
    }
  }
  return { ...gold, items };
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
      const url = new URL(request.url);
      const view = url.searchParams.get("view") || "logs";
      const limit = Number(url.searchParams.get("limit")) || 50;
      if (view === "gold") {
        const gold = await listQaGold(d1, {
          limit,
          includeInactive: url.searchParams.get("all") === "1",
        });
        const enriched = [];
        for (const g of gold) {
          enriched.push(await expandBindItems(d1, g));
        }
        return jsonResponse({ success: true, gold: enriched });
      }
      const logs = await listEnterpriseQa(d1, {
        limit,
        review_status: url.searchParams.get("status") || "",
        category: url.searchParams.get("category") || "",
      });
      return jsonResponse({ success: true, logs });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method !== "POST" && request.method !== "PATCH") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  try {
    await assertCatalogOpsAccess(env, body.phone || "");
  } catch (e) {
    return opsAuthErrorResponse(e);
  }

  const action = String(body.action || "").trim();

  try {
    if (action === "save") {
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse({ success: false, error: "缺少 id" }, 400);
      const qa = await updateEnterpriseQaReview(d1, id, {
        review_status: body.review_status || body.reviewStatus,
        review_focus: body.review_focus != null ? body.review_focus : body.reviewFocus,
        review_note: body.review_note != null ? body.review_note : body.reviewNote,
        corrected_category:
          body.corrected_category != null
            ? body.corrected_category
            : body.correctedCategory,
        corrected_reply:
          body.corrected_reply != null
            ? body.corrected_reply
            : body.correctedReply,
        corrected_hit_ids:
          body.corrected_hit_ids != null
            ? body.corrected_hit_ids
            : body.correctedHitIds,
      });
      return jsonResponse({ success: true, qa });
    }

    if (action === "publish") {
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse({ success: false, error: "缺少 id" }, 400);
      // 先确保有纠正内容：若 body 带纠正字段，先 save
      if (
        body.corrected_reply != null ||
        body.corrected_hit_ids != null ||
        body.corrected_category != null ||
        body.review_status
      ) {
        await updateEnterpriseQaReview(d1, id, {
          review_status: body.review_status || "bad",
          corrected_category: body.corrected_category || body.correctedCategory,
          corrected_reply: body.corrected_reply || body.correctedReply,
          corrected_hit_ids: body.corrected_hit_ids || body.correctedHitIds,
          review_note: body.review_note || body.reviewNote,
        });
      }
      const gold = await publishQaFromReview(d1, id, {
        question_canonical: body.question_canonical || body.questionCanonical,
        question_variants: body.question_variants || body.questionVariants,
        answer_kind: body.answer_kind || body.answerKind,
      });
      let vector = null;
      try {
        vector = await indexQaGold(env, gold);
      } catch (ve) {
        return jsonResponse({
          success: true,
          gold,
          vector_error: String((ve && ve.message) || ve),
          warning: "已写入标准答表，但向量回灌失败",
        });
      }
      return jsonResponse({ success: true, gold, vector });
    }

    if (action === "unpublish") {
      const goldId = String(body.gold_id || body.goldId || body.id || "").trim();
      if (!goldId) {
        return jsonResponse({ success: false, error: "缺少 gold_id" }, 400);
      }
      const before = await getQaGold(d1, goldId);
      const gold = await unpublishQaGold(d1, goldId);
      let vector = null;
      if (before) {
        try {
          vector = await deleteQaGoldVectors(env, before);
        } catch (ve) {
          vector = { error: String((ve && ve.message) || ve) };
        }
      }
      return jsonResponse({ success: true, gold, vector });
    }

    if (action === "get") {
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse({ success: false, error: "缺少 id" }, 400);
      const qa = await getEnterpriseQa(d1, id);
      if (!qa) return jsonResponse({ success: false, error: "未找到" }, 404);
      return jsonResponse({ success: true, qa });
    }

    return jsonResponse({ success: false, error: "未知 action" }, 400);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 400);
  }
}
