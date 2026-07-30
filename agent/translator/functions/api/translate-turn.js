/**
 * POST /api/translate-turn
 * 一口译回合：音频 → ASR → LLM 翻译
 *
 * Body JSON:
 *   { phone, direction: "me"|"them", audio: "data:audio/wav;base64,..." | 纯 base64 }
 * direction=me   → 源中文，译英文（我对对方说）
 * direction=them → 源英文，译中文（对方对我说）
 *
 * Returns:
 *   { success, sourceText, translatedText, sourceLang, targetLang, speakText, latencyMs }
 */

import {
  assertTranslatorAccess,
  translatorAuthErrorResponse,
} from "../lib/access.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../../../functions/lib/openai-compat.js";
import { loadLlmModels } from "../../../functions/lib/llm-models-store.js";
import { describeDoubao, describeQwen } from "../../../functions/lib/tier1.js";
import { pickKvBinding } from "../../../functions/lib/host.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function asrBase(env) {
  const raw = (env && (env.ASR_SERVICE_URL || env.ASR_URL)) || "";
  return String(raw).trim().replace(/\/+$/, "");
}

function asrKey(env) {
  return String((env && env.ASR_API_KEY) || "").trim();
}

function stripDataUrl(audio) {
  const s = String(audio || "").trim();
  const m = /^data:[^;]+;base64,(.+)$/i.exec(s);
  return m ? m[1] : s;
}

async function runAsrBase64(env, b64) {
  const base = asrBase(env);
  if (!base) {
    return {
      ok: false,
      error:
        "ASR_SERVICE_URL 未配置。请在 Pages 环境变量中设置，并启动 services/asr。",
    };
  }
  const headers = { "Content-Type": "application/json" };
  const key = asrKey(env);
  if (key) headers["X-API-Key"] = key;
  let upstream;
  try {
    upstream = await fetch(base + "/asr/base64", {
      method: "POST",
      headers,
      body: JSON.stringify({ audio: b64 }),
    });
  } catch (e) {
    return {
      ok: false,
      error: "无法连接 ASR：" + String((e && e.message) || e),
    };
  }
  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    return { ok: false, error: "ASR 返回非 JSON" };
  }
  if (!upstream.ok || data.success === false) {
    return {
      ok: false,
      error: String((data && (data.error || data.detail)) || "ASR failed"),
    };
  }
  const text = String(data.text || data.result || "").trim();
  return { ok: true, text, raw: data };
}

function translateTargets(env, models) {
  const out = [];
  const enabled = (models || []).filter((m) => m && m.enabled !== false);
  const tier1 = enabled
    .filter((m) => m.tier === 1)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const m of tier1) {
    if (!m.modelId || !m.baseUrl) continue;
    if (!resolveApiKey(env, m.apiKeyEnv)) continue;
    out.push(m);
  }
  const q = describeQwen(env);
  if (q.target) out.push(q.target);
  const d = describeDoubao(env);
  if (d.target) out.push(d.target);
  return out;
}

async function translateWithLlm(env, models, text, targetLang) {
  const src = String(text || "").trim();
  if (!src) return { ok: false, error: "empty source" };
  const toEn = targetLang === "en";
  const system = toEn
    ? "You are a simultaneous interpreter. Translate the user's Chinese speech into natural spoken English. Output ONLY the English translation, no quotes, labels, or notes."
    : "你是同声传译。把用户的英文口语译成自然、简洁的中文口语。只输出中文译文，不要引号、标签或解释。";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: src },
  ];
  const candidates = translateTargets(env, models);
  if (!candidates.length) {
    return {
      ok: false,
      error: "无可用翻译模型（请配置 SILICONFLOW_API_KEY / ARK_API_KEY 或模型库）",
    };
  }
  const errors = [];
  for (const m of candidates) {
    const apiKey = resolveApiKey(env, m.apiKeyEnv);
    const res = await chatCompletions({
      baseUrl: m.baseUrl,
      apiKey,
      model: m.modelId,
      messages,
      temperature: 0.2,
      max_tokens: 512,
      timeoutMs: 45000,
    });
    if (!res.ok) {
      errors.push((m.label || m.id || m.modelId) + ": " + (res.error || res.status));
      continue;
    }
    const out = extractAssistantText(res.data).trim();
    if (!out) {
      errors.push((m.label || m.id || m.modelId) + ": empty");
      continue;
    }
    return {
      ok: true,
      text: out,
      model: { id: m.id, label: m.label || m.modelId, modelId: m.modelId },
    };
  }
  return { ok: false, error: errors.join(" | ") || "translate failed" };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const phone = body && body.phone;
  try {
    await assertTranslatorAccess(env, phone);
  } catch (err) {
    return translatorAuthErrorResponse(err);
  }

  const direction = String((body && body.direction) || "me").toLowerCase();
  const sourceLang = direction === "them" ? "en" : "zh";
  const targetLang = direction === "them" ? "zh" : "en";
  const b64 = stripDataUrl(body && body.audio);
  if (!b64 || b64.length < 32) {
    return jsonResponse({ success: false, error: "缺少 audio" }, 400);
  }

  const t0 = Date.now();
  const asr = await runAsrBase64(env, b64);
  if (!asr.ok) {
    return jsonResponse(
      { success: false, error: asr.error || "ASR failed", stage: "asr" },
      502
    );
  }
  if (!asr.text) {
    return jsonResponse(
      {
        success: false,
        error: "未识别到语音，请靠近话筒再说一次",
        stage: "asr",
        sourceText: "",
      },
      422
    );
  }

  let models = [];
  try {
    const kv = pickKvBinding(env);
    if (kv) {
      const pack = await loadLlmModels(kv, env);
      models = (pack && pack.models) || [];
    }
  } catch (e) {}

  const tr = await translateWithLlm(env, models, asr.text, targetLang);
  if (!tr.ok) {
    return jsonResponse(
      {
        success: false,
        error: tr.error || "translate failed",
        stage: "translate",
        sourceText: asr.text,
        sourceLang,
        targetLang,
      },
      502
    );
  }

  return jsonResponse({
    success: true,
    direction: direction === "them" ? "them" : "me",
    sourceText: asr.text,
    translatedText: tr.text,
    sourceLang,
    targetLang,
    speakText: tr.text,
    model: tr.model || null,
    latencyMs: Date.now() - t0,
  });
}
