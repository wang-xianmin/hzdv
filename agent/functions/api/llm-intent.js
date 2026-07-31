/**
 * POST /api/llm-intent
 * 仅跑意图分类（短请求），供前端先展示跟踪，再另调 /api/llm-chat 生成回复。
 *
 * Body: { phone, message, lang?, ocr? }
 * Returns: { success, intent: { tier, web, latencyMs, raw, error }, notes, model }
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import { detectTextLang, normalizeUiLang } from "../lib/tier1.js";
import { classifyIntent } from "../lib/intent.js";

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

  try {
    const intent = await classifyIntent(env, classifyText);
    const notes = [];
    if (intent.tier) {
      notes.push(
        uiLang === "en"
          ? "Intent → tier" +
            intent.tier +
            (intent.web ? " +web" : "") +
            " · " +
            intent.latencyMs +
            "ms" +
            (intent.raw ? ' · raw "' + intent.raw + '"' : "")
          : "意图分类 → tier" +
            intent.tier +
            (intent.web ? " +web" : "") +
            " · " +
            intent.latencyMs +
            "ms" +
            (intent.raw ? " · 原文「" + intent.raw + "」" : "")
      );
    } else {
      notes.push(
        uiLang === "en"
          ? "Intent failed (" +
            (intent.error || "error") +
            ")" +
            (intent.raw ? ' · raw "' + intent.raw + '"' : "") +
            " · " +
            (intent.latencyMs || 0) +
            "ms"
          : "意图分类失败（" +
            (intent.error || "错误") +
            "）" +
            (intent.raw ? " · 原文「" + intent.raw + "」" : "") +
            " · " +
            (intent.latencyMs || 0) +
            "ms"
      );
    }
    notes.push(
      uiLang === "en"
        ? "Phase intent done → client will call /api/llm-chat"
        : "意图阶段完成 → 前端将继续调用 /api/llm-chat"
    );

    return jsonResponse({
      success: true,
      phase: "intent",
      intent: {
        tier: intent.tier,
        web: !!intent.web,
        latencyMs: intent.latencyMs || 0,
        raw: intent.raw || "",
        error: intent.error || null,
      },
      notes,
      latencyMs: intent.latencyMs || 0,
      model: {
        id: "auto",
        label: "Auto",
        modelId: "",
        tier: intent.tier || 0,
        via: "intent",
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
