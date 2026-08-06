/**
 * POST /api/llm-intent
 * 仅跑意图分类（短请求），供前端先展示跟踪，再另调 /api/llm-chat 生成回复。
 *
 * Body: { phone, message, lang?, ocr? }
 * Returns: { success, intent: { tier, catalog, web, latencyMs, raw, error }, notes, model }
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
  pickKvBinding,
} from "../lib/host.js";
import { detectTextLang, normalizeUiLang } from "../lib/tier1.js";
import { classifyIntent, intentChannelSuffix } from "../lib/intent.js";
import {
  clientCountryFromRequest,
  formatRouteModeNote,
  resolveRouteDecision,
} from "../lib/route-mode.js";
import { loadLlmModels } from "../lib/llm-models-store.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeOcrForClassify(ocr) {
  if (!ocr || typeof ocr !== "object") return { present: false, text: "" };
  const text = String(ocr.text_llm || ocr.text || "").trim();
  return { present: !!text, text: text.slice(0, 6000) };
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

  const message = String(body.message || body.prompt || "").trim();
  if (!message) {
    return jsonResponse({ success: false, error: "缺少 message" }, 400);
  }

  const uiLang = normalizeUiLang(body.lang || body.locale || "zh");
  const replyLang = detectTextLang(message, uiLang);
  const ocr = normalizeOcrForClassify(body.ocr);
  const classifyText = ocr.present ? message + "\n" + ocr.text : message;
  const history = Array.isArray(body.history) ? body.history : [];
  let classifyPayload = classifyText;
  if (history.length) {
    const lines = [];
    let budget = 600;
    for (let i = Math.max(0, history.length - 6); i < history.length; i++) {
      const row = history[i];
      if (!row) continue;
      const role = row.role === "assistant" ? "助手" : "用户";
      let t = String(row.content || row.text || "").trim();
      if (!t || /^思考中|^Thinking/i.test(t)) continue;
      t = t.slice(0, 120);
      if (budget - t.length < 0) break;
      budget -= t.length;
      lines.push(role + "：" + t);
    }
    if (lines.length) {
      classifyPayload =
        "【近期对话】\n" + lines.join("\n") + "\n【当前】\n" + classifyText;
    }
  }
  const systemSettings = body.systemSettings || body.system_settings || {};
  const country = clientCountryFromRequest(request);
  const routeDecision = resolveRouteDecision(systemSettings, env, { country });
  const routeMode = routeDecision.mode;

  let models = [];
  if (routeMode === "cf") {
    try {
      const kv = pickKvBinding(env);
      if (kv) {
        const loaded = await loadLlmModels(kv, env);
        models = loaded.models || [];
      }
    } catch (eModels) {
      models = [];
    }
  }

  try {
    const intent = await classifyIntent(env, classifyPayload, {
      routeMode,
      systemSettings,
      models,
      country,
    });
    const notes = [];
    notes.push("① " + formatRouteModeNote(routeDecision, uiLang));
    if (intent.via || intent.label) {
      notes.push(
        uiLang === "en"
          ? "① Classifier → " + (intent.label || intent.via || "")
          : "① 分类器 → " + (intent.label || intent.via || "")
      );
    }
    const ch = intentChannelSuffix(intent);
    if (intent.tier) {
      notes.push(
        uiLang === "en"
          ? "① Intent → tier" +
            intent.tier +
            ch +
            " · " +
            intent.latencyMs +
            "ms" +
            (intent.raw ? ' · raw "' + intent.raw + '"' : "")
          : "① 意图 → tier" +
            intent.tier +
            ch +
            " · " +
            intent.latencyMs +
            "ms" +
            (intent.raw ? " · 原文「" + intent.raw + "」" : "")
      );
    } else {
      notes.push(
        uiLang === "en"
          ? "① Intent failed (" +
            (intent.error || "error") +
            ")" +
            (intent.raw ? ' · raw "' + intent.raw + '"' : "") +
            " · " +
            (intent.latencyMs || 0) +
            "ms"
          : "① 意图失败（" +
            (intent.error || "错误") +
            "）" +
            (intent.raw ? " · 原文「" + intent.raw + "」" : "") +
            " · " +
            (intent.latencyMs || 0) +
            "ms"
      );
    }
    notes.push(
      intent.catalog
        ? uiLang === "en"
          ? "Step 1 intent done → next: site catalog / showcase"
          : "① 意图完成 → 下一步：站内目录 / 主展区"
        : intent.web
          ? uiLang === "en"
            ? "Step 1/3 intent done → next: web search"
            : "① 意图完成 → 下一步：联网检索"
          : uiLang === "en"
            ? "Step 1/2 intent done → next: generate"
            : "① 意图完成 → 下一步：生成回答"
    );

    return jsonResponse({
      success: true,
      phase: "intent",
      routeMode,
      routeDecision,
      intent: {
        tier: intent.tier,
        catalog: !!intent.catalog,
        web: !!intent.web,
        latencyMs: intent.latencyMs || 0,
        raw: intent.raw || "",
        error: intent.error || null,
        via: intent.via || null,
      },
      notes,
      latencyMs: intent.latencyMs || 0,
      model: {
        id: "auto",
        label: intent.label || "Auto",
        modelId: "",
        tier: intent.tier || 0,
        via: intent.via || "intent",
        uiLang,
        replyLang,
      },
    });
  } catch (e) {
    console.error("llm-intent:", e);
    return jsonResponse(
      {
        success: false,
        phase: "intent",
        error: String((e && e.message) || e || "intent failed"),
      },
      500
    );
  }
}
