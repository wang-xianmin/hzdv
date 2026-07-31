/**
 * POST /api/translate-turn
 * 一口译回合：音频 → ASR → LLM 翻译（默认 SSE：先推原文，再流式译文）
 *
 * Body JSON:
 *   { phone, direction: "me"|"them", audio: base64, stream?: true }
 * stream 默认 true；false 时返回整包 JSON（兼容）
 *
 * SSE events:
 *   asr    { sourceText, sourceLang, targetLang, direction }
 *   delta  { text }          // 译文累计全文
 *   done   { translatedText, speakText, model, latencyMs, ... }
 *   error  { error, stage, sourceText? }
 */

import {
  assertTranslatorAccess,
  translatorAuthErrorResponse,
} from "../lib/access.js";
import {
  chatCompletions,
  chatCompletionsStream,
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

function sseResponse(stream) {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

function sseData(obj) {
  return "data: " + JSON.stringify(obj) + "\n\n";
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
  // 去重 modelId+baseUrl
  const seen = new Set();
  return out.filter((m) => {
    const k = String(m.baseUrl) + "|" + String(m.modelId);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 口语同传提示：忽略犹豫停顿，输出流畅整句 */
function buildTranslateMessages(text, targetLang) {
  const src = String(text || "").trim();
  const toEn = targetLang === "en";
  const system = toEn
    ? [
        "You are a professional consecutive interpreter (Chinese → English).",
        "The input is spoken Chinese that may include hesitations, fillers (嗯/啊/那个), false starts, or short thinking pauses.",
        "Produce ONE natural, fluent spoken English utterance a listener can hear aloud.",
        "Rules:",
        "- Keep the speaker's meaning; do not add facts.",
        "- Smooth over fillers and restarts; do NOT translate 嗯/啊/那个/就是 literally.",
        "- Prefer complete sentences; avoid choppy fragments or word-by-word calques.",
        "- Output ONLY the English translation: no quotes, labels, pinyin, or notes.",
      ].join("\n")
    : [
        "你是专业交替传译（英文→中文）。",
        "输入是英语口语，可能含停顿、重复、语气词或改口。",
        "请输出一句自然、连贯、适合朗读的中文口语。",
        "规则：",
        "- 忠实原意，不添加事实；",
        "- 略过无意义的语气词与改口残留，不要逐词生硬直译；",
        "- 避免碎句堆砌；",
        "- 只输出中文译文，不要引号、标签或解释。",
      ].join("\n");
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: toEn
        ? "Spoken Chinese to interpret:\n" + src
        : "Spoken English to interpret:\n" + src,
    },
  ];
}

async function loadModels(env) {
  try {
    const kv = pickKvBinding(env);
    if (kv) {
      const pack = await loadLlmModels(kv, env);
      return (pack && pack.models) || [];
    }
  } catch (e) {}
  return [];
}

async function translateWithLlmStream(env, models, text, targetLang, onDelta) {
  const src = String(text || "").trim();
  if (!src) return { ok: false, error: "empty source" };
  const messages = buildTranslateMessages(src, targetLang);
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
    const res = await chatCompletionsStream({
      baseUrl: m.baseUrl,
      apiKey,
      model: m.modelId,
      messages,
      temperature: 0.25,
      max_tokens: 512,
      timeoutMs: 60000,
      onDelta,
    });
    if (!res.ok || !res.text) {
      // 流式失败则试非流式兜底
      const fallback = await chatCompletions({
        baseUrl: m.baseUrl,
        apiKey,
        model: m.modelId,
        messages,
        temperature: 0.25,
        max_tokens: 512,
        timeoutMs: 45000,
      });
      if (fallback.ok) {
        const out = extractAssistantText(fallback.data).trim();
        if (out) {
          if (onDelta) onDelta(out, out);
          return {
            ok: true,
            text: out,
            model: { id: m.id, label: m.label || m.modelId, modelId: m.modelId },
          };
        }
      }
      errors.push(
        (m.label || m.id || m.modelId) +
          ": " +
          (res.error || (fallback && fallback.error) || "empty")
      );
      continue;
    }
    return {
      ok: true,
      text: res.text,
      model: { id: m.id, label: m.label || m.modelId, modelId: m.modelId },
    };
  }
  return { ok: false, error: errors.join(" | ") || "translate failed" };
}

async function translateWithLlm(env, models, text, targetLang) {
  const src = String(text || "").trim();
  if (!src) return { ok: false, error: "empty source" };
  const messages = buildTranslateMessages(src, targetLang);
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
      temperature: 0.25,
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
  const wantStream = body && body.stream === false ? false : true;
  const b64 = stripDataUrl(body && body.audio);
  if (!b64 || b64.length < 32) {
    return jsonResponse({ success: false, error: "缺少 audio" }, 400);
  }

  const t0 = Date.now();

  if (!wantStream) {
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
    const models = await loadModels(env);
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        controller.enqueue(encoder.encode(sseData(obj)));
      };
      try {
        const asr = await runAsrBase64(env, b64);
        if (!asr.ok) {
          send({ type: "error", stage: "asr", error: asr.error || "ASR failed" });
          controller.close();
          return;
        }
        if (!asr.text) {
          send({
            type: "error",
            stage: "asr",
            error: "未识别到语音，请靠近话筒再说一次",
            sourceText: "",
          });
          controller.close();
          return;
        }

        send({
          type: "asr",
          direction: direction === "them" ? "them" : "me",
          sourceText: asr.text,
          sourceLang,
          targetLang,
        });

        const models = await loadModels(env);
        let lastFull = "";
        const tr = await translateWithLlmStream(
          env,
          models,
          asr.text,
          targetLang,
          (full) => {
            lastFull = full;
            send({ type: "delta", text: full });
          }
        );
        if (!tr.ok) {
          send({
            type: "error",
            stage: "translate",
            error: tr.error || "translate failed",
            sourceText: asr.text,
            sourceLang,
            targetLang,
          });
          controller.close();
          return;
        }
        const finalText = (tr.text || lastFull || "").trim();
        send({
          type: "done",
          success: true,
          direction: direction === "them" ? "them" : "me",
          sourceText: asr.text,
          translatedText: finalText,
          speakText: finalText,
          sourceLang,
          targetLang,
          model: tr.model || null,
          latencyMs: Date.now() - t0,
        });
      } catch (e) {
        send({
          type: "error",
          stage: "server",
          error: String((e && e.message) || e),
        });
      }
      controller.close();
    },
  });

  return sseResponse(stream);
}
