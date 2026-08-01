/**
 * POST /api/llm-chat
 * 最小对话入口（调试用）：按所选模型或 Auto 解析后的模型调用 OpenAI 兼容接口。
 *
 * Body: { phone, message, modelId?: "auto" | <registry id>, lang?: "zh"|"en" }
 * Returns: { success, reply, model: {...}, attempts, notes, latencyMs, error? }
 *
 * Auto：先用 VPS 上的 Qwen2.5-1.5B 分类器给消息定级（见 lib/intent.js），
 * 再按模型库（KV）里对应梯队的排序依次尝试：
 *   tier1 → [1,2,3]，tier2 → [2,3,1]，tier3 → [3,2,1]
 * 分类器标 web、关键词启发式或 body.webSearch=true 时先 Tavily 搜网再注入 system。
 * 前端 Auto 推荐：先 POST /api/llm-intent，再本接口并带 body.intent 复用分类结果（缩短单次墙钟）。
 * 若配置 LLM_PROXY_SERVICE_URL，③ 生成经 VPS llm-proxy 转发云端（意图分类仍走 INTENT_*）。
 * 分类器未配置或失败时从第一梯队开始。梯队内顺序即模型库里的排序，与菜单语言无关。
 * 回复语言只看提问语言。需要联网时配 TAVILY_API_KEY。
 *
 * 带附件时：body.ocr 传入 /api/ocr 的结果（含 layout 排版硬校验），
 * text_llm + 用户问题一并送意图分类；复杂 PDF 页可带 image_base64。
 * 图片 OCR：layout.suggested_tier 作梯队下限（只抬不降）。
 * PDF：提取阶段已准备好文本/整页渲图；对话路由完全由意图分类决定（可走 tier2，
 * 或无视觉的 tier3，如 deepseek-v4-pro）；有图且模型 caps.vision 时才附图。
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
  pickKvBinding,
  kvBindingHint,
} from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";
import { detectTextLang, normalizeUiLang } from "../lib/tier1.js";
import { classifyIntent } from "../lib/intent.js";
import { resolveGenerateProxy, resolveRouteMode } from "../lib/route-mode.js";
import {
  formatWebContext,
  heuristicNeedsWeb,
  searchTavily,
  tavilyConfigured,
} from "../lib/tavily.js";
import { loadWebsearchRefineRules } from "../lib/websearch-refine-store.js";

/** 可调默认值；运行时可由 body.systemSettings（D1 系统参数）覆盖 */
const OCR_TEXT_MAX_PDF = 14000;
const OCR_TEXT_MAX_IMAGE = 6000;
const OCR_VISION_MAX_PAGES = 6;

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function resolveOcrLimits(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    textMaxPdf: clampInt(s.ocrTextMaxPdf, 1000, 200000, OCR_TEXT_MAX_PDF),
    textMaxImage: clampInt(s.ocrTextMaxImage, 500, 100000, OCR_TEXT_MAX_IMAGE),
    visionMaxPages: clampInt(s.ocrVisionMaxPages, 1, 20, OCR_VISION_MAX_PAGES),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 按梯队顺序取出模型库里可用的模型（有 Key、baseUrl 完整、已启用）。
 * preferVision：图片场景把带 vision 能力的模型排到同梯队前面。
 */
function registryCandidates(env, models, tierOrder, preferVision) {
  const enabled = (models || []).filter((m) => m && m.enabled !== false);
  const out = [];
  for (const tier of tierOrder) {
    const list = enabled
      .filter((m) => m.tier === tier)
      .sort((a, b) => {
        if (preferVision) {
          const av = a.caps && a.caps.vision ? 0 : 1;
          const bv = b.caps && b.caps.vision ? 0 : 1;
          if (av !== bv) return av - bv;
        }
        return (a.order || 0) - (b.order || 0);
      });
    for (const m of list) {
      if (!m.modelId || !m.baseUrl) continue;
      if (String(m.baseUrl).includes("{WorkspaceId}")) continue;
      if (!resolveApiKey(env, m.apiKeyEnv)) continue;
      out.push({ target: m, via: "auto→tier" + tier });
    }
  }
  return out;
}

/** 联网总结时跳过易崩的小模型（如 Qwen2.5-7B 易重复乱码） */
function isWeakWebSummarizer(m) {
  const id = String((m && m.modelId) || "").toLowerCase();
  const label = String((m && m.label) || "").toLowerCase();
  return /qwen2\.5-7b/.test(id) || /qwen2\.5-7b/.test(label);
}

/**
 * 归一化前端传来的 OCR/PDF 上下文（来自 /api/ocr 的 layout 硬校验结果）。
 * PDF 可含 pages[].image_base64（复杂页整页渲图），供 tier3 视觉。
 */
function normalizeOcrContext(raw, limits) {
  const lim = limits || resolveOcrLimits(null);
  if (!raw || typeof raw !== "object") {
    return {
      present: false,
      text: "",
      floorTier: 0,
      complex: false,
      needsVision: false,
      reasons: [],
      lineCount: 0,
      source: "",
      visionImages: [],
      visionPages: [],
    };
  }
  const layout = raw.layout && typeof raw.layout === "object" ? raw.layout : {};
  const floor = Number(layout.suggested_tier || layout.suggestedTier || 0);
  const source =
    String(raw.source || "").trim() ||
    (raw.page_count != null || raw.pageCount != null ? "pdf" : "image");
  const textRaw = String(raw.text_llm || raw.text || "");
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const visionImages = [];
  const visionPages = [];
  const visionCap = lim.visionMaxPages;
  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    const b64 = String(p.image_base64 || p.imageBase64 || "").trim();
    if (!b64) continue;
    const pageNo = Number(p.page || 0) || visionImages.length + 1;
    visionImages.push({
      page: pageNo,
      mime: String(p.image_mime || p.imageMime || "image/jpeg"),
      base64: b64.slice(0, 2_500_000),
    });
    visionPages.push(pageNo);
    if (visionImages.length >= visionCap) break;
  }
  // layout.vision_pages 兜底（无 base64 时仍可标记）
  if (!visionPages.length && Array.isArray(layout.vision_pages)) {
    for (const n of layout.vision_pages.slice(0, visionCap)) {
      const pageNo = Number(n);
      if (pageNo > 0) visionPages.push(pageNo);
    }
  }
  const needsVision =
    !!(layout.needs_vision || layout.needsVision) || visionImages.length > 0;
  return {
    present: true,
    text: textRaw.slice(0, source === "pdf" ? lim.textMaxPdf : lim.textMaxImage),
    floorTier: floor >= 1 && floor <= 3 ? floor : 0,
    complex: !!layout.complex,
    needsVision,
    reasons: Array.isArray(layout.reasons) ? layout.reasons.slice(0, 8).map(String) : [],
    lineCount: Number(raw.line_count || raw.lineCount || 0) || 0,
    source,
    visionImages,
    visionPages,
  };
}

function modelMeta(target, via, extra) {
  return {
    id: (target && target.id) || null,
    label: (target && (target.label || target.modelId)) || "",
    modelId: (target && target.modelId) || "",
    tier: target && target.tier,
    via,
    apiKeyEnv: target && target.apiKeyEnv,
    preference: target && target.preference,
    ...(extra || {}),
  };
}

function ocrPromptBlock(ocr, replyLang) {
  if (!ocr || !ocr.present) return "";
  const isPdf = ocr.source === "pdf";
  const hasText = !!String(ocr.text || "").trim();
  const hasVision = (ocr.visionImages || []).length > 0;
  if (!hasText && !hasVision) return "";

  const visionNote =
    hasVision &&
    (replyLang === "en"
      ? " Vision pages (full-page renders) are attached as images: " +
        (ocr.visionPages || []).join(", ") +
        ". Prefer the images for those pages; use extracted text for other pages."
      : " 复杂页已整页渲图并附在消息中（页码：" +
        (ocr.visionPages || []).join("、") +
        "）。这些页请以图为准；其它页参考下方提取文本。");

  const warn = ocr.complex
    ? replyLang === "en"
      ? " The layout check flagged complexity (" +
        (ocr.reasons.join(", ") || "complex") +
        ")."
      : "（排版硬校验：复杂——" + (ocr.reasons.join("、") || "复杂") + "）"
    : "";

  if (!hasText) {
    return replyLang === "en"
      ? "\n\nThe user attached a " +
          (isPdf ? "PDF" : "image") +
          "." +
          (visionNote || " Please read the attached page image(s).") +
          warn
      : "\n\n用户附了" +
          (isPdf ? " PDF" : "图片") +
          "。" +
          (visionNote || "请阅读附图。") +
          warn;
  }

  if (replyLang === "en") {
    return (
      (isPdf
        ? "\n\nThe user attached a PDF. Extracted text (simple pages):\n---\n"
        : "\n\nThe user attached an image. OCR extracted:\n---\n") +
      ocr.text +
      "\n---" +
      (visionNote || "") +
      warn
    );
  }
  return (
    (isPdf
      ? "\n\n用户附了一份 PDF，简单页提取文字如下：\n---\n"
      : "\n\n用户附了一张图片，OCR 提取文字：\n---\n") +
    ocr.text +
    "\n---" +
    (visionNote || "") +
    warn
  );
}

function systemPrompt(replyLang, ocr, hasWeb) {
  if (replyLang === "en") {
    return (
      "You are the HZDV site assistant. Be concise and direct. " +
      "Always answer in the same language the user wrote in. " +
      "The user wrote in English, so answer in English. " +
      "Ignore the site menu language." +
      (hasWeb
        ? " WEB MATERIALS RULES (mandatory): " +
          "1) Use ONLY the materials provided in the user message for time-sensitive or factual claims. " +
          "2) Do NOT invent titles, sites, headlines, or URLs. Every URL you cite must appear verbatim in the materials. " +
          "3) Say “not in the materials” ONLY if the materials are empty or clearly unrelated. " +
          "If the materials already contain numbered items [1][2]… and the user asks for news/front page/HN/hot topics, you MUST list those items — never refuse with “no news today”. " +
          "4) Copy each URL exactly from the materials (character-for-character). " +
          "5) A Hacker News / hot-list feed is current front-page news; treat it as today’s topics. " +
          "6) When answering in English, you may keep original titles."
        : "") +
      ocrPromptBlock(ocr, "en")
    );
  }
  return (
    "你是 HZDV 站点助手。回答简洁、直接。" +
    "始终使用与用户提问相同的语言回答。" +
    "本次用户用中文提问，请用中文回答。" +
    "不要参考站点菜单语言。" +
    (hasWeb
      ? "【联网材料硬性规则】" +
        "1）涉及新闻/实时/事实，只能依据用户消息中附带的联网材料作答；" +
        "2）禁止捏造标题、网站名或链接；URL 必须从材料中逐字符原样复制，不得改写、补全或拼接；" +
        "3）仅当材料为空或与问题完全无关时，才说「材料里没有」。" +
        "若材料已有 [1][2]… 编号条目，且用户在问新闻/热门/HN/今日，必须逐条列出，禁止用「没有今天的新闻」拒绝；" +
        "4）每条格式：中文译名（可简短）+ 原文标题 + 原样 URL；英文标题不要擅自改写，URL 不要翻译；" +
        "5）Hacker News / 热门列表即为当前最新热帖，可当作「今天」的新闻汇报；" +
        "6）用户用中文提问时，必须提供中文译名，不要只贴英文标题。"
      : "") +
    ocrPromptBlock(ocr, "zh")
  );
}

function buildUserContent(message, ocr, useVision) {
  const images = useVision && ocr && ocr.visionImages ? ocr.visionImages : [];
  if (!images.length) return message;
  const hint =
    (ocr && ocr.source === "pdf"
      ? "（下列图片为 PDF 复杂页整页渲染，页码见文件名说明）"
      : "") || "";
  const parts = [{ type: "text", text: String(message || "") + (hint ? "\n" + hint : "") }];
  for (const img of images) {
    const page = img.page != null ? "page-" + img.page : "page";
    parts.push({
      type: "text",
      text: "\n[" + page + "]",
    });
    parts.push({
      type: "image_url",
      image_url: {
        url: "data:" + (img.mime || "image/jpeg") + ";base64," + img.base64,
      },
    });
  }
  return parts;
}

async function callModel(env, target, message, replyLang, ocr, useVision, webCtx, opts) {
  const apiKey = resolveApiKey(env, target.apiKeyEnv);
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      data: null,
      latencyMs: 0,
      error: "环境变量未配置：" + (target.apiKeyEnv || "(空)"),
      reply: "",
    };
  }
  if (String(target.baseUrl || "").includes("{WorkspaceId}")) {
    return {
      ok: false,
      status: 0,
      data: null,
      latencyMs: 0,
      error: "baseUrl 仍含 {WorkspaceId}",
      reply: "",
    };
  }

  const wantVision =
    !!useVision &&
    !!(ocr && ocr.visionImages && ocr.visionImages.length) &&
    !!(target.caps && target.caps.vision);
  const hasWeb = !!(webCtx && String(webCtx).trim());
  let userContent = buildUserContent(message, ocr, wantVision);
  // 小模型对 user 里的材料更听话；有列表时避免误报「材料里没有」
  if (hasWeb) {
    const bridge =
      replyLang === "en"
        ? "\n\nUse the materials below. If they contain numbered items, list them — do not say the materials are empty or that there is no news today. Copy URLs exactly.\n\n"
        : "\n\n请根据下列材料用中文回答。若已有编号条目，必须逐条汇报：" +
          "每条给出【中文译名】、原文标题、以及材料中的原样 URL（禁止改 URL）。" +
          "禁止说「材料里没有」或「没有今天的新闻」。\n\n";
    const block = bridge + String(webCtx).trim();
    if (typeof userContent === "string") {
      userContent = userContent + block;
    } else if (Array.isArray(userContent)) {
      userContent = userContent.concat([{ type: "text", text: block }]);
    }
  }
  const systemSettings = (opts && opts.systemSettings) || {};
  const proxy = resolveGenerateProxy(env, systemSettings);
  const timeoutMs =
    (opts && opts.timeoutMs) ||
    (proxy ? (wantVision ? 90000 : 60000) : wantVision ? 55000 : 28000);
  const maxTokens =
    (opts && opts.maxTokens) || (wantVision ? 2048 : 1024);
  const result = await chatCompletions({
    baseUrl: proxy ? proxy.baseUrl : target.baseUrl,
    apiKey: proxy ? proxy.apiKey : apiKey,
    upstreamBaseUrl: proxy ? target.baseUrl : null,
    upstreamApiKey: proxy ? apiKey : null,
    model: target.modelId,
    messages: [
      { role: "system", content: systemPrompt(replyLang, ocr, hasWeb) },
      { role: "user", content: userContent },
    ],
    temperature: hasWeb ? 0.1 : 0.3,
    max_tokens: maxTokens,
    timeoutMs,
  });
  const reply = extractAssistantText(result.data) || "";
  if (result.ok && !String(reply).trim()) {
    return {
      ...result,
      ok: false,
      reply: "",
      error:
        "上游返回空内容（检查 Model ID「" +
        (target.modelId || "") +
        "」是否已在百炼/方舟开通，以及 ALIYUN_MAAS_API_KEY 是否有权访问该模型）",
    };
  }
  return {
    ...result,
    reply,
    usedVision: wantVision,
    viaProxy: !!proxy,
  };
}

/**
 * 决定是否搜网并拉取 Tavily 材料。
 * force：body.webSearch / body.forceWeb
 * intentWeb：分类器标了 web
 * heuristicNeedsWeb：仅作「要不要搜」的兜底，不替代意图分类、不跳过分类器
 */
async function resolveWebContext(env, message, replyLang, opts) {
  const force = !!(opts && (opts.force || opts.intentWeb));
  const heuristic = heuristicNeedsWeb(message);
  const want = force || heuristic;
  if (!want) {
    return { webCtx: "", pack: null, used: false, skipped: "not_needed" };
  }
  if (!tavilyConfigured(env)) {
    return {
      webCtx: "",
      pack: null,
      used: false,
      skipped: "no_key",
      note:
        replyLang === "en"
          ? "Web search needed but TAVILY_API_KEY is not set"
          : "问题可能需要联网，但未配置 TAVILY_API_KEY",
    };
  }
  const ss = (opts && opts.systemSettings) || {};
  const maxResults = ss.tavilyMaxResults;
  const depthFlag = ss.tavilySearchDepth;
  const searchDepth =
    depthFlag === 1 || depthFlag === "1" || depthFlag === true
      ? "advanced"
      : "basic";
  let refineRules = null;
  try {
    const kv = pickKvBinding(env);
    if (kv) {
      const loaded = await loadWebsearchRefineRules(kv);
      refineRules = loaded.rules || null;
    }
  } catch (eRules) {
    refineRules = null;
  }
  const pack = await searchTavily(env, message, {
    maxResults:
      opts && opts.maxResults != null
        ? opts.maxResults
        : maxResults,
    searchDepth: searchDepth,
    timeoutMs: (opts && opts.timeoutMs) || undefined,
    rules: refineRules,
  });
  if (!pack.ok) {
    return {
      webCtx: "",
      pack,
      used: false,
      skipped: "search_failed",
      note:
        replyLang === "en"
          ? "Tavily failed: " + (pack.error || "error") + " (" + pack.latencyMs + "ms)"
          : "Tavily 检索失败：" + (pack.error || "错误") + "（" + pack.latencyMs + "ms）",
    };
  }
  const webCtx = formatWebContext(pack, replyLang);
  return {
    webCtx,
    pack,
    used: true,
    skipped: null,
    note:
      replyLang === "en"
        ? "Tavily: " +
          pack.results.length +
          " sources · " +
          searchDepth +
          " (" +
          pack.latencyMs +
          "ms)"
        : "联网检索 Tavily：" +
          pack.results.length +
          " 条 · " +
          searchDepth +
          "（" +
          pack.latencyMs +
          "ms）",
  };
}

function packChatResult(result, model, via, langInfo, extras) {
  const ok = !!(result && result.ok && String(result.reply || "").trim());
  return {
    success: ok,
    reply: (result && result.reply) || "",
    latencyMs: result && result.latencyMs,
    upstreamStatus: result && result.status,
    error: ok
      ? null
      : (result && result.error) ||
        (result && result.ok ? "上游返回空内容" : "调用失败"),
    model: modelMeta(model, via, langInfo),
    upstream: ok ? undefined : result && result.data,
    ...(extras || {}),
  };
}

function failNote(attempt, uiLang) {
  const why = attempt.error || "failed";
  return uiLang === "en"
    ? attempt.label + " failed: " + why
    : attempt.label + " 调用失败：" + why;
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

  /** 与「系统运维」解耦：任意已注册用户即可对话（暂不按 type 收紧） */
  try {
    await assertAnyLoginAccess(env, body.phone || "");
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  try {
    return await handleLlmChat(env, body);
  } catch (e) {
    console.error("llm-chat:", e);
    return jsonResponse(
      {
        success: false,
        error: String((e && e.message) || e || "llm-chat failed"),
      },
      500
    );
  }
}

async function handleLlmChat(env, body) {
  const message = String(body.message || body.prompt || "").trim();
  if (!message) {
    return jsonResponse({ success: false, error: "缺少 message" }, 400);
  }

  const uiLang = normalizeUiLang(body.lang || body.locale || "zh");
  const replyLang = detectTextLang(message, uiLang);
  const langInfo = { uiLang, replyLang };
  const wantId = String(body.modelId || body.model || "auto").trim() || "auto";
  const ocrLimits = resolveOcrLimits(body.systemSettings || body.system_settings);
  const ocr = normalizeOcrContext(body.ocr, ocrLimits);

  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse({ success: false, error: "KV not configured", hint: kvBindingHint() }, 503);
  }
  const { models } = await loadLlmModels(kv, env);
  const systemSettings = body.systemSettings || body.system_settings || {};
  const routeMode = resolveRouteMode(systemSettings, env);

  if (wantId !== "auto") {
    const hit = (models || []).find((m) => m.id === wantId);
    if (!hit) {
      return jsonResponse({ success: false, error: "模型不存在：" + wantId }, 404);
    }
    const useVision = !!(ocr.needsVision && ocr.visionImages && ocr.visionImages.length);
    const forceWeb = body.webSearch === true || body.forceWeb === true;
    const web = await resolveWebContext(env, message, replyLang, {
      force: forceWeb,
      intentWeb: false,
      systemSettings,
    });
    const notes = [];
    if (web.note) notes.push(web.note);
    if (routeMode === "cf") {
      notes.push(
        uiLang === "en"
          ? "Route mode → cf (CF → cloud LLM)"
          : "路由模式 → cf（CF 直调云端）"
      );
    }
    const result = await callModel(
      env,
      hit,
      message,
      replyLang,
      ocr,
      useVision,
      web.webCtx || "",
      { systemSettings }
    );
    if (result.usedVision) {
      notes.push(
        uiLang === "en"
          ? "Vision: " + (ocr.visionPages || []).join(", ") + " page image(s)"
          : "视觉：" + (ocr.visionPages || []).join("、") + " 页整页渲图"
      );
    }
    const bodyOut = packChatResult(result, hit, "manual", langInfo, {
      notes,
      webSearch: web.used
        ? {
            query: web.pack && web.pack.query,
            count: web.pack && web.pack.results ? web.pack.results.length : 0,
            latencyMs: web.pack && web.pack.latencyMs,
          }
        : null,
    });
    return jsonResponse(bodyOut, bodyOut.success ? 200 : 502);
  }

  const attempts = [];
  const notes = [];
  const proxy = resolveGenerateProxy(env, systemSettings);
  /**
   * 墙钟预算：仅用于在 Cloudflare 掐断前尽量返回 JSON。
   * 经 VPS llm-proxy 时放宽（上游慢活在 VPS，路径更稳）；否则分阶段收紧。
   */
  const budgetMs = proxy
    ? Object.prototype.hasOwnProperty.call(body, "intent") ||
      body.webProvided === true
      ? 90000
      : 95000
    : body.webProvided === true ||
        Object.prototype.hasOwnProperty.call(body, "intent")
      ? 22000
      : 45000;
  const t0 = Date.now();
  function remMs() {
    return budgetMs - (Date.now() - t0);
  }

  notes.push(
    uiLang === "en"
      ? "③ Route mode → " + routeMode
      : "③ 路由模式 → " +
        (routeMode === "cf" ? "cf（国内/直调）" : "vps")
  );
  if (proxy) {
    notes.push(
      uiLang === "en"
        ? "③ Generate via VPS llm-proxy → cloud LLM"
        : "③ 生成经 VPS llm-proxy → 云端 LLM"
    );
  } else if (routeMode === "cf") {
    notes.push(
      uiLang === "en"
        ? "③ Generate: CF → cloud LLM (no VPS proxy)"
        : "③ 生成：CF 直调云端（不经 VPS proxy）"
    );
  }

  const tier1Cands = registryCandidates(env, models, [1]);
  const forceWeb = body.webSearch === true || body.forceWeb === true;

  /** 前端可先调 /api/llm-intent，再把结果放进 body.intent，本请求跳过分类以缩短墙钟 */
  let intent;
  if (Object.prototype.hasOwnProperty.call(body, "intent")) {
    const provided =
      body.intent && typeof body.intent === "object"
        ? body.intent
        : { tier: null, web: false, latencyMs: 0, error: null, raw: "" };
    const tierNum = Number(provided.tier);
    intent = {
      tier: tierNum === 1 || tierNum === 2 || tierNum === 3 ? tierNum : null,
      web: !!provided.web,
      latencyMs: Number(provided.latencyMs) || 0,
      error: provided.error || null,
      raw: String(provided.raw || ""),
    };
    notes.push(
      uiLang === "en"
        ? "③ Generate: using intent from step 1 → " +
          (intent.tier
            ? "tier" + intent.tier + (intent.web ? " +web" : "")
            : "none")
        : "③ 生成：沿用第①步意图 → " +
          (intent.tier
            ? "tier" + intent.tier + (intent.web ? " +web" : "")
            : "无有效分级")
    );
  } else {
    const classifyText =
      ocr.present && ocr.text ? message + "\n" + ocr.text : message;
    intent = await classifyIntent(env, classifyText, {
      routeMode,
      systemSettings,
      models,
    });
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
            "ms → default order"
          : "意图分类失败（" +
            (intent.error || "错误") +
            "）" +
            (intent.raw ? " · 原文「" + intent.raw + "」" : "") +
            " · " +
            (intent.latencyMs || 0) +
            "ms → 按默认顺序"
      );
    }
  }

  notes.push(
    Object.prototype.hasOwnProperty.call(body, "intent") ||
      body.webProvided === true
      ? uiLang === "en"
        ? "③ Generate wall budget " + budgetMs + "ms"
        : "③ 生成阶段墙钟预算 " + budgetMs + "ms"
      : uiLang === "en"
        ? "Wall budget " + budgetMs + "ms · left " + remMs() + "ms after intent"
        : "墙钟预算 " + budgetMs + "ms · 分类后剩余 " + remMs() + "ms"
  );

  /** 前端可先调 /api/llm-websearch，再带 webCtx / webProvided，本请求跳过 Tavily */
  let web;
  if (body.webProvided === true || typeof body.webCtx === "string") {
    const ctx = typeof body.webCtx === "string" ? body.webCtx : "";
    web = {
      webCtx: ctx,
      pack: body.webPack && typeof body.webPack === "object" ? body.webPack : null,
      used: !!ctx,
      skipped: ctx ? null : body.webSkipped || "provided_empty",
      note:
        body.webNote ||
        (uiLang === "en"
          ? ctx
            ? "③ Generate: using web context from step 2"
            : "③ Generate: no web context from step 2"
          : ctx
            ? "③ 生成：沿用第②步联网材料"
            : "③ 生成：第②步无联网材料"),
    };
  } else {
    web = await resolveWebContext(env, message, replyLang, {
      force: forceWeb || !!intent.web,
      intentWeb: !!intent.web,
      systemSettings,
      timeoutMs: 12000,
    });
  }
  if (web.note) notes.push(web.note);
  const webCtx = web.webCtx || "";

  const phased =
    Object.prototype.hasOwnProperty.call(body, "intent") ||
    body.webProvided === true;

  // 图片 OCR：排版硬校验只做下限（不降级）。
  // PDF：提取已准备文本/渲图，对话梯队交给意图分类（文档+用户问题），
  // 可走 tier2 或无视觉的 tier3；不因「页复杂」强行抬到 3 / 跳过 2。
  let routeTier = intent.tier || 0;
  const routeBits = [];
  if (web.used && routeTier < 2) {
    routeTier = 2;
    routeBits.push(uiLang === "en" ? "web floor" : "联网下限");
  }
  if (ocr.present && ocr.source !== "pdf" && ocr.floorTier > routeTier) {
    routeTier = ocr.floorTier;
    routeBits.push(
      uiLang === "en"
        ? "layout" + (ocr.reasons.length ? ":" + ocr.reasons.join(",") : "")
        : "排版" + (ocr.reasons.length ? ":" + ocr.reasons.join("、") : "")
    );
  }
  if (routeTier) {
    notes.push(
      uiLang === "en"
        ? (phased ? "③ " : "") +
          "Route → tier" +
          routeTier +
          (routeBits.length ? " (" + routeBits.join("; ") + ")" : "")
        : (phased ? "③ " : "") +
          "路由 → tier" +
          routeTier +
          (routeBits.length ? "（" + routeBits.join("；") + "）" : "")
    );
  }

  const hasVisionPages = !!(ocr.visionImages && ocr.visionImages.length);
  // 仅当意图落到 tier3 且有整页渲图时，同梯队内优先带视觉的模型；
  // tier2 / 无视觉的 tier3（如 deepseek-v4-pro）照常可用，callModel 会按 caps.vision 决定是否附图。
  const preferVision = ocr.present && hasVisionPages && routeTier >= 3;
  const useVision = hasVisionPages;
  if (ocr.present && hasVisionPages) {
    notes.push(
      uiLang === "en"
        ? "PDF page renders ready (pages " +
          (ocr.visionPages || []).join(", ") +
          "); attach only if model has vision"
        : "PDF 复杂页渲图已备（页 " +
          (ocr.visionPages || []).join("、") +
          "）；仅视觉模型会附带"
    );
  }

  // 有附件或已搜网时不预热 tier1：上下文已变，预热会答非所问
  const primary = ocr.present || webCtx ? null : tier1Cands[0] || null;
  const primaryPromise = primary
    ? callModel(env, primary.target, message, replyLang, ocr, false, "", {
        systemSettings,
      })
    : null;

  /** 分阶段且已有检索材料：优先快模型总结，并截断上下文，避免 CF 墙钟 HTML 502 */
  let webCtxForCall = webCtx;
  if (phased && webCtxForCall && webCtxForCall.length > 3500) {
    webCtxForCall = webCtxForCall.slice(0, 3500) + "\n…(truncated)";
    notes.push(
      uiLang === "en"
        ? "③ Generate: web context truncated to 3500 chars"
        : "③ 生成：联网材料已截断至 3500 字"
    );
  }

  let queue;
  if (phased && webCtxForCall) {
    const t2 = registryCandidates(env, models, [2], false).filter(
      (c) => !isWeakWebSummarizer(c.target)
    );
    const t1 = registryCandidates(env, models, [1], false).filter(
      (c) => !isWeakWebSummarizer(c.target)
    );
    queue = t2.length ? t2.concat(t1) : t1.length ? t1 : registryCandidates(env, models, [2, 1], false);
    notes.push(
      uiLang === "en"
        ? "③ Generate → prefer tier2 then tier1 (summarize search)"
        : "③ 生成 → 优先 tier2 再 tier1（总结检索）"
    );
  } else if (routeTier === 2) {
    queue = registryCandidates(env, models, [2, 3, 1], preferVision);
  } else if (routeTier === 3) {
    queue = registryCandidates(env, models, [3, 2, 1], preferVision);
  } else {
    queue = [...tier1Cands, ...registryCandidates(env, models, [2, 3]).slice(0, 1)];
  }
  if (!queue.length) {
    notes.push(
      uiLang === "en"
        ? "No usable model in the library (check enabled flags and API key env vars)"
        : "模型库无可用模型（检查启用开关与密钥环境变量）"
    );
  }

  const webMeta = web.used
    ? {
        query: web.pack && web.pack.query,
        count: web.pack && web.pack.results ? web.pack.results.length : 0,
        latencyMs: web.pack && web.pack.latencyMs,
      }
    : body.webSearch && typeof body.webSearch === "object"
      ? body.webSearch
      : null;

  if (remMs() < 2500) {
    notes.push(
      uiLang === "en"
        ? "Budget left " + remMs() + "ms → skip LLM (return JSON before CF HTML 502)"
        : "剩余预算 " + remMs() + "ms → 跳过 LLM（先回 JSON，避免 Cloudflare HTML 502）"
    );
    return jsonResponse(
      {
        success: false,
        error:
          uiLang === "en"
            ? "Stopped before Cloudflare timeout (not enough time left for LLM)"
            : "已在 Cloudflare 超时前中止（剩余时间不够调模型）",
        notes,
        attempts,
        webSearch: webMeta,
        model: {
          id: "auto",
          label: "Auto",
          modelId: "",
          tier: routeTier || 0,
          via: "auto→budget",
          ...langInfo,
        },
      },
      504
    );
  }

  let lastFail = null;
  /** 分阶段：有代理时可等多一点；无代理仍短超时防 CF HTML 502 */
  const maxAttempts = phased ? 1 : webCtxForCall ? 2 : 4;
  const callOpts = Object.assign(
    { systemSettings },
    phased
      ? {
          timeoutMs: proxy
            ? Math.min(75000, Math.max(20000, remMs() - 3000))
            : Math.min(12000, Math.max(5000, remMs() - 2000)),
          maxTokens: 500,
        }
      : {}
  );
  notes.push(
    uiLang === "en"
      ? "③ LLM timeout budget " +
        ((callOpts && callOpts.timeoutMs) || (proxy ? 60000 : 28000)) +
        "ms · attempts " +
        maxAttempts
      : "③ LLM 超时预算 " +
        ((callOpts && callOpts.timeoutMs) || (proxy ? 60000 : 28000)) +
        "ms · 尝试 " +
        maxAttempts +
        " 次"
  );

  function hardTimeoutResult(ms) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({
          ok: false,
          status: 0,
          data: null,
          latencyMs: ms,
          error:
            uiLang === "en"
              ? "Hard timeout " + ms + "ms (avoid CF HTML 502)"
              : "生成硬超时 " + ms + "ms（避免 CF HTML 502）",
          reply: "",
        });
      }, ms);
    });
  }

  for (const { target, via } of queue.slice(0, maxAttempts)) {
    const tCall = Date.now();
    const hardMs = phased
      ? proxy
        ? Math.min(80000, Math.max(25000, remMs() - 2000))
        : Math.min(14000, Math.max(6000, remMs() - 1000))
      : proxy
        ? 95000
        : 60000;
    const modelPromise =
      primaryPromise && primary && target.id === primary.target.id
        ? primaryPromise
        : callModel(
            env,
            target,
            message,
            replyLang,
            ocr,
            useVision,
            webCtxForCall,
            callOpts
          );
    const result = phased
      ? await Promise.race([modelPromise, hardTimeoutResult(hardMs)])
      : await modelPromise;
    notes.push(
      uiLang === "en"
        ? "Tried " +
          (target.label || target.modelId) +
          " · " +
          (Date.now() - tCall) +
          "ms"
        : "尝试 " +
          (target.label || target.modelId) +
          " · " +
          (Date.now() - tCall) +
          "ms"
    );
    const attempt = {
      label: target.label,
      modelId: target.modelId,
      preference: target.preference || via.replace("auto→", ""),
      ok: !!(result.ok && String(result.reply || "").trim()),
      error: result.error || null,
      latencyMs: result.latencyMs,
      usedVision: !!result.usedVision,
    };
    attempts.push(attempt);
    if (attempt.ok) {
      if (result.usedVision) {
        notes.push(
          uiLang === "en"
            ? "Used vision page image(s)"
            : "已附复杂页整页渲图"
        );
      }
      return jsonResponse(
        packChatResult(result, target, via, langInfo, {
          attempts,
          notes,
          webSearch: webMeta,
        })
      );
    }
    if (result.ok && !result.error) attempt.error = "上游返回空内容";
    notes.push(failNote(attempt, uiLang));
    lastFail = { result, target, via };
  }

  if (lastFail) {
    const bodyOut = packChatResult(lastFail.result, lastFail.target, lastFail.via, langInfo, {
      attempts,
      notes,
      webSearch: webMeta,
    });
    return jsonResponse(bodyOut, 502);
  }

  return jsonResponse(
    {
      success: false,
      error:
        uiLang === "en"
          ? "No usable model for Auto. Enable models in the library and set their API key env vars."
          : "Auto 未找到可用模型（在模型库启用模型，并确认密钥环境变量已配置）",
      model: { id: "auto", label: "Auto", modelId: "", tier: 0, via: "auto→none", ...langInfo },
      attempts,
      notes,
      webSearch: webMeta,
    },
    400
  );
}
