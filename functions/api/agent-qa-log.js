/**
 * POST /api/agent-qa-log
 * 企业相关问答打点（登录用户）。仅记 catalog / 企业问，不写黄金库。
 * 落库成功后若配置了收件人，异步邮件通知（Resend；失败不影响打点）。
 *
 * Body: {
 *   phone, question, reply_text?, answer_mode?, hits?,
 *   category?, category_source?, intent_tier?, intent_catalog?,
 *   session_id?, model_badge?, locale?
 * }
 *
 * 通知收件人：系统设置 agentQaNotifyEmails 与/或 env AGENT_QA_NOTIFY_EMAILS
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding } from "../lib/cloudflare-bindings.js";
import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/ops-auth.js";
import {
  insertEnterpriseQa,
} from "../lib/agent-qa-d1.js";
import { notifyEnterpriseQaEmails } from "../lib/agent-qa-notify.js";
import {
  detectCatalogKind,
  isCompanyCatalogQuery,
  resolveEnterpriseCategory,
} from "../lib/catalog-query-intent.js";
import { getCatalogSynonymMap } from "../lib/catalog-synonyms.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  try {
    await assertAnyLoginAccess(env, body.phone || "");
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  const question = String(body.question || body.message || "").trim();
  if (!question) {
    return jsonResponse({ success: false, error: "缺少 question" }, 400);
  }

  const intentCatalog = body.intent_catalog !== false && body.intentCatalog !== false;
  const forceEnterprise = !!(body.enterprise || body.force);
  let synonymMap = null;
  const d1 = pickD1Binding(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }

  try {
    await ensureAllD1Tables(d1);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 500);
  }

  try {
    synonymMap = await getCatalogSynonymMap(d1);
  } catch (e) {
    synonymMap = null;
  }

  const company =
    forceEnterprise ||
    intentCatalog ||
    isCompanyCatalogQuery(question, synonymMap) ||
    !!detectCatalogKind(question, synonymMap);

  if (!company) {
    return jsonResponse({
      success: true,
      skipped: true,
      reason: "not_enterprise",
    });
  }

  const hits = Array.isArray(body.hits)
    ? body.hits
    : Array.isArray(body.catalogItems)
      ? body.catalogItems
      : [];

  let category = body.category;
  let category_source = body.category_source || body.categorySource;
  if (!category) {
    const resolved = resolveEnterpriseCategory(question, hits, synonymMap);
    category = resolved.category;
    category_source = resolved.category_source;
  }

  try {
    const row = await insertEnterpriseQa(d1, {
      question,
      reply_text: body.reply_text || body.replyText || body.text || "",
      answer_mode: body.answer_mode || body.answerMode || "prose",
      hits,
      category,
      category_source,
      intent_tier: body.intent_tier != null ? body.intent_tier : body.intentTier,
      intent_catalog: true,
      session_id: body.session_id || body.sessionId || "",
      user_phone: body.phone || "",
      model_badge: body.model_badge || body.modelBadge || "",
      locale: body.locale || body.lang || "",
    });

    const siteOrigin = (() => {
      try {
        return new URL(request.url).origin;
      } catch (e) {
        return "";
      }
    })();
    const notifyTask = notifyEnterpriseQaEmails(env, d1, row, {
      siteOrigin,
    }).catch((e) => {
      console.error("[agent-qa-log] notify failed", e);
      return null;
    });
    if (context.waitUntil) {
      context.waitUntil(notifyTask);
    } else {
      await notifyTask;
    }

    return jsonResponse({ success: true, id: row.id, qa: row });
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 500);
  }
}
