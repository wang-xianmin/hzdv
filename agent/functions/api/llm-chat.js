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
import {
  formatWebContext,
  heuristicNeedsWeb,
  searchTavily,
  tavilyConfigured,
} from "../lib/tavily.js";

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

function systemPrompt(replyLang, ocr, webCtx) {
  const webBlock =
    webCtx && String(webCtx).trim()
      ? (replyLang === "en" ? "\n\n" : "\n\n") + String(webCtx).trim()
      : "";
  if (replyLang === "en") {
    return (
      "You are the HZDV site assistant. Be concise and direct. " +
      "Always answer in the same language the user wrote in. " +
      "The user wrote in English, so answer in English. " +
      "Ignore the site menu language." +
      (webBlock
        ? " When web search results are provided, ground factual claims in them and cite URLs."
        : "") +
      ocrPromptBlock(ocr, "en") +
      webBlock
    );
  }
  return (
    "你是 HZDV 站点助手。回答简洁、直接。" +
    "始终使用与用户提问相同的语言回答。" +
    "本次用户用中文提问，请用中文回答。" +
    "不要参考站点菜单语言。" +
    (webBlock ? "若提供了联网检索结果，事实性内容请依据材料并注明来源链接。" : "") +
    ocrPromptBlock(ocr, "zh") +
    webBlock
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

async function callModel(env, target, message, replyLang, ocr, useVision, webCtx) {
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
  const userContent = buildUserContent(message, ocr, wantVision);
  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      { role: "system", content: systemPrompt(replyLang, ocr, webCtx) },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: wantVision ? 2048 : 1024,
    timeoutMs: wantVision ? 120000 : 60000,
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
  return { ...result, reply, usedVision: wantVision };
}

/**
 * 决定是否搜网并拉取 Tavily 材料。
 * force：body.webSearch / body.forceWeb
 * intentWeb：分类器标了 web
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
  const pack = await searchTavily(env, message, {
    maxResults: maxResults,
    searchDepth: searchDepth,
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
      systemSettings: body.systemSettings || body.system_settings || {},
    });
    const notes = [];
    if (web.note) notes.push(web.note);
    const result = await callModel(
      env,
      hit,
      message,
      replyLang,
      ocr,
      useVision,
      web.webCtx || ""
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

  const tier1Cands = registryCandidates(env, models, [1]);

  // 意图分类：分类文本带上 OCR 结果，让分类器看到图里的内容而不只是提问那句话
  const classifyText = ocr.present && ocr.text ? message + "\n" + ocr.text : message;
  const intent = await classifyIntent(env, classifyText);
  if (intent.tier) {
    notes.unshift(
      uiLang === "en"
        ? "Intent: tier" +
          intent.tier +
          (intent.web ? "+web" : "") +
          " (" +
          intent.latencyMs +
          "ms)"
        : "意图分类：tier" +
          intent.tier +
          (intent.web ? "+web" : "") +
          "（" +
          intent.latencyMs +
          "ms）"
    );
  } else if (String(env.INTENT_SERVICE_URL || "").trim()) {
    notes.unshift(
      uiLang === "en"
        ? "Intent classifier unavailable (" + (intent.error || "error") + "), default order"
        : "分类器不可用（" + (intent.error || "错误") + "），按默认顺序"
    );
  }

  const forceWeb = body.webSearch === true || body.forceWeb === true;
  const web = await resolveWebContext(env, message, replyLang, {
    force: forceWeb || !!intent.web,
    intentWeb: !!intent.web,
    systemSettings: body.systemSettings || body.system_settings || {},
  });
  if (web.note) notes.push(web.note);
  const webCtx = web.webCtx || "";

  // 图片 OCR：排版硬校验只做下限（不降级）。
  // PDF：提取已准备文本/渲图，对话梯队交给意图分类（文档+用户问题），
  // 可走 tier2 或无视觉的 tier3；不因「页复杂」强行抬到 3 / 跳过 2。
  let routeTier = intent.tier || 0;
  if (web.used && routeTier < 2) {
    routeTier = 2;
    notes.push(
      uiLang === "en"
        ? "Web search raised routing floor to tier2"
        : "联网检索将路由下限抬到 tier2"
    );
  }
  if (ocr.present && ocr.source !== "pdf" && ocr.floorTier > routeTier) {
    routeTier = ocr.floorTier;
    notes.push(
      uiLang === "en"
        ? "Layout check raised routing to tier" +
          routeTier +
          (ocr.reasons.length ? " (" + ocr.reasons.join(", ") + ")" : "")
        : "排版硬校验抬到 tier" +
          routeTier +
          (ocr.reasons.length ? "（" + ocr.reasons.join("、") + "）" : "")
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
    ? callModel(env, primary.target, message, replyLang, ocr, false, "")
    : null;

  let queue;
  if (routeTier === 2) {
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
    : null;

  let lastFail = null;
  for (const { target, via } of queue.slice(0, 4)) {
    const result =
      primaryPromise && primary && target.id === primary.target.id
        ? await primaryPromise
        : await callModel(env, target, message, replyLang, ocr, useVision, webCtx);
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
