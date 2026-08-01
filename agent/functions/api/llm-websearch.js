/**
 * POST /api/llm-websearch
 * 仅 Tavily 搜网（短请求），供 Auto 在意图之后、生成之前单独调用。
 *
 * Body: { phone, message, lang?, intent?, systemSettings?, forceWeb? }
 * Returns: { success, webCtx, webSearch, notes, skipped? }
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import { detectTextLang, normalizeUiLang } from "../lib/tier1.js";
import {
  formatWebContext,
  heuristicNeedsWeb,
  searchTavily,
  tavilyConfigured,
} from "../lib/tavily.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
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
  const forceWeb = body.webSearch === true || body.forceWeb === true;
  const intentWeb = !!(body.intent && body.intent.web);
  const want = forceWeb || intentWeb || heuristicNeedsWeb(message);
  const notes = [];

  if (!want) {
    notes.push(
      uiLang === "en" ? "② Web search skipped (not needed)" : "② 联网检索跳过（不需要）"
    );
    return jsonResponse({
      success: true,
      phase: "websearch",
      skipped: "not_needed",
      webCtx: "",
      webSearch: null,
      notes,
    });
  }

  if (!tavilyConfigured(env)) {
    notes.push(
      uiLang === "en"
        ? "② Web search needed but TAVILY_API_KEY is not set"
        : "② 需要联网，但未配置 TAVILY_API_KEY"
    );
    return jsonResponse({
      success: true,
      phase: "websearch",
      skipped: "no_key",
      webCtx: "",
      webSearch: null,
      notes,
    });
  }

  const ss = body.systemSettings || body.system_settings || {};
  const maxResults = clampInt(ss.tavilyMaxResults, 1, 10, 5);
  const depthFlag = ss.tavilySearchDepth;
  const searchDepth =
    depthFlag === 1 || depthFlag === "1" || depthFlag === true
      ? "advanced"
      : "basic";

  try {
    const pack = await searchTavily(env, message, {
      maxResults: Math.min(maxResults, 5),
      searchDepth,
      timeoutMs: 10000,
    });
    if (!pack.ok) {
      notes.push(
        uiLang === "en"
          ? "② Tavily failed: " + (pack.error || "error") + " (" + pack.latencyMs + "ms)"
          : "② Tavily 失败：" + (pack.error || "错误") + "（" + pack.latencyMs + "ms）"
      );
      return jsonResponse({
        success: true,
        phase: "websearch",
        skipped: "search_failed",
        webCtx: "",
        webSearch: {
          query: pack.query,
          count: 0,
          latencyMs: pack.latencyMs,
          error: pack.error || null,
        },
        notes,
      });
    }

    const webCtx = formatWebContext(pack, replyLang);
    notes.push(
      uiLang === "en"
        ? "② Tavily: " +
          pack.results.length +
          " sources · " +
          searchDepth +
          " (" +
          pack.latencyMs +
          "ms)"
        : "② Tavily：" +
          pack.results.length +
          " 条 · " +
          searchDepth +
          "（" +
          pack.latencyMs +
          "ms）"
    );
    notes.push(
      uiLang === "en"
        ? "Step 2/3 web search done → next: generate"
        : "② 搜网完成 → 下一步：生成回答"
    );

    return jsonResponse({
      success: true,
      phase: "websearch",
      webCtx,
      webSearch: {
        query: pack.query,
        count: pack.results.length,
        latencyMs: pack.latencyMs,
      },
      notes,
      latencyMs: pack.latencyMs,
    });
  } catch (e) {
    console.error("llm-websearch:", e);
    return jsonResponse(
      {
        success: false,
        phase: "websearch",
        error: String((e && e.message) || e || "websearch failed"),
        notes,
      },
      500
    );
  }
}
