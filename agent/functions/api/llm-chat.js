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
 * 分类器未配置或失败时从第一梯队开始。梯队内顺序即模型库里的排序，与菜单语言无关。
 * 回复语言只看提问语言。
 *
 * 带图片时：body.ocr 传入 /api/ocr 的结果（含 layout 排版硬校验），
 * OCR 文字进分类与 system prompt，layout.suggested_tier 作为梯队下限（只抬不降）。
 */

import { assertOpsAccess, opsAuthErrorResponse, pickKvBinding, kvBindingHint } from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";
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
 * @returns {{ present: boolean, text: string, floorTier: number, complex: boolean,
 *             needsVision: boolean, reasons: string[], lineCount: number, source: string }}
 */
function normalizeOcrContext(raw) {
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
    };
  }
  const layout = raw.layout && typeof raw.layout === "object" ? raw.layout : {};
  const floor = Number(layout.suggested_tier || layout.suggestedTier || 0);
  const source =
    String(raw.source || "").trim() ||
    (raw.page_count != null || raw.pageCount != null ? "pdf" : "image");
  return {
    present: true,
    text: String(raw.text || "").slice(0, source === "pdf" ? 12000 : 6000),
    floorTier: floor >= 1 && floor <= 3 ? floor : 0,
    complex: !!layout.complex,
    needsVision: !!(layout.needs_vision || layout.needsVision),
    reasons: Array.isArray(layout.reasons) ? layout.reasons.slice(0, 8).map(String) : [],
    lineCount: Number(raw.line_count || raw.lineCount || 0) || 0,
    source,
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
  if (!ocr || !ocr.present || !String(ocr.text || "").trim()) return "";
  const isPdf = ocr.source === "pdf";
  const warn = ocr.complex
    ? replyLang === "en"
      ? " The layout check flagged it as complex (" +
        (ocr.reasons.join(", ") || "complex") +
        "), so reading order may be scrambled — infer structure carefully and say so if ambiguous."
      : "（排版硬校验判为复杂：" +
        (ocr.reasons.join("、") || "复杂") +
        "，阅读顺序可能错乱，请谨慎推断结构，拿不准就说明）"
    : "";
  if (replyLang === "en") {
    return (
      (isPdf
        ? "\n\nThe user attached a PDF. Extracted text:\n---\n"
        : "\n\nThe user attached an image. OCR (RapidOCR) extracted this text:\n---\n") +
      ocr.text +
      "\n---" +
      warn
    );
  }
  return (
    (isPdf
      ? "\n\n用户附了一份 PDF，已提取到以下文字：\n---\n"
      : "\n\n用户附了一张图片，OCR（RapidOCR）提取到以下文字：\n---\n") +
    ocr.text +
    "\n---" +
    warn
  );
}

function systemPrompt(replyLang, ocr) {
  if (replyLang === "en") {
    return (
      "You are the HZDV site assistant. Be concise and direct. " +
      "Always answer in the same language the user wrote in. " +
      "The user wrote in English, so answer in English. " +
      "Ignore the site menu language." +
      ocrPromptBlock(ocr, "en")
    );
  }
  return (
    "你是 HZDV 站点助手。回答简洁、直接。" +
    "始终使用与用户提问相同的语言回答。" +
    "本次用户用中文提问，请用中文回答。" +
    "不要参考站点菜单语言。" +
    ocrPromptBlock(ocr, "zh")
  );
}

async function callModel(env, target, message, replyLang, ocr) {
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

  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      { role: "system", content: systemPrompt(replyLang, ocr) },
      { role: "user", content: message },
    ],
    temperature: 0.3,
    max_tokens: 1024,
    timeoutMs: 60000,
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
  return { ...result, reply };
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

  try {
    await assertOpsAccess(env, body.phone || "");
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
  const ocr = normalizeOcrContext(body.ocr);

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
    const result = await callModel(env, hit, message, replyLang, ocr);
    const bodyOut = packChatResult(result, hit, "manual", langInfo, { notes: [] });
    return jsonResponse(bodyOut, bodyOut.success ? 200 : 502);
  }

  const attempts = [];
  const notes = [];

  const tier1Cands = registryCandidates(env, models, [1]);

  // 有图时不并行预热：OCR 场景大概率被硬校验抬到二/三梯队，预热就是纯浪费
  const primary = ocr.present ? null : tier1Cands[0] || null;
  const primaryPromise = primary
    ? callModel(env, primary.target, message, replyLang, ocr)
    : null;

  // 意图分类：分类文本带上 OCR 结果，让分类器看到图里的内容而不只是提问那句话
  const classifyText = ocr.present && ocr.text ? message + "\n" + ocr.text : message;
  const intent = await classifyIntent(env, classifyText);
  if (intent.tier) {
    notes.unshift(
      uiLang === "en"
        ? "Intent: tier" + intent.tier + " (" + intent.latencyMs + "ms)"
        : "意图分类：tier" + intent.tier + "（" + intent.latencyMs + "ms）"
    );
  } else if (String(env.INTENT_SERVICE_URL || "").trim()) {
    notes.unshift(
      uiLang === "en"
        ? "Intent classifier unavailable (" + (intent.error || "error") + "), default order"
        : "分类器不可用（" + (intent.error || "错误") + "），按默认顺序"
    );
  }

  // 排版硬校验只做下限（不降级）：小模型常把带图请求误判成闲聊，
  // 结构复杂时必须交给更强的模型，否则 OCR 纯文本的阅读顺序会被读错。
  let routeTier = intent.tier || 0;
  if (ocr.present && ocr.floorTier > routeTier) {
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
  if (ocr.present && ocr.needsVision) {
    notes.push(
      uiLang === "en"
        ? "OCR quality poor — preferring vision-capable models"
        : "OCR 质量差，优先选带视觉能力的模型"
    );
  }

  const preferVision = ocr.present && ocr.needsVision;
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

  let lastFail = null;
  for (const { target, via } of queue.slice(0, 4)) {
    const result =
      primaryPromise && primary && target.id === primary.target.id
        ? await primaryPromise
        : await callModel(env, target, message, replyLang, ocr);
    const attempt = {
      label: target.label,
      modelId: target.modelId,
      preference: target.preference || via.replace("auto→", ""),
      ok: !!(result.ok && String(result.reply || "").trim()),
      error: result.error || null,
      latencyMs: result.latencyMs,
    };
    attempts.push(attempt);
    if (attempt.ok) {
      return jsonResponse(
        packChatResult(result, target, via, langInfo, { attempts, notes })
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
    },
    400
  );
}
