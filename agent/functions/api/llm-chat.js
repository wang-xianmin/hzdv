/**
 * POST /api/llm-chat
 * 最小对话入口（调试用）：按所选模型或 Auto 解析后的模型调用 OpenAI 兼容接口。
 *
 * Body: { phone, message, modelId?: "auto" | <registry id>, lang?: "zh"|"en" }
 * Returns: { success, reply, model: { id, label, modelId, tier, via }, latencyMs, error? }
 *
 * Auto：
 *   第一梯队按界面语言选主备（中文 Doubao 首选 / 英文 Qwen 首选），主失败则试备；
 *   若第一梯队都不可用，再落到第二/三梯队第一个有 Key 的启用模型。
 */

import { assertOpsAccess, opsAuthErrorResponse, pickKvBinding, kvBindingHint } from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";
import { normalizeUiLang, tier1Candidates } from "../lib/tier1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function pickRegistryFallback(env, models) {
  const enabled = (models || []).filter((m) => m && m.enabled !== false);
  const byTier = (tier) =>
    enabled
      .filter((m) => m.tier === tier)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const tier of [2, 3]) {
    for (const m of byTier(tier)) {
      if (!m.modelId || !m.baseUrl) continue;
      if (String(m.baseUrl).includes("{WorkspaceId}")) continue;
      if (!resolveApiKey(env, m.apiKeyEnv)) continue;
      return { target: m, via: "auto→tier" + tier };
    }
  }
  return { target: null, via: "auto→none" };
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

async function callModel(env, target, message, lang) {
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

  const sys =
    lang === "en"
      ? "You are the HZDV site assistant. Be concise and direct. Reply in English."
      : "你是 HZDV 站点助手。回答简洁、直接。用中文回复。";

  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: message },
    ],
    temperature: 0.3,
    max_tokens: 1024,
    timeoutMs: 60000,
  });
  return {
    ...result,
    reply: extractAssistantText(result.data) || "",
  };
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

  const lang = normalizeUiLang(body.lang || body.locale || "zh");
  const wantId = String(body.modelId || body.model || "auto").trim() || "auto";
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse({ success: false, error: "KV not configured", hint: kvBindingHint() }, 503);
  }

  const { models } = await loadLlmModels(kv);

  // 手动指定模型库条目
  if (wantId !== "auto") {
    const hit = (models || []).find((m) => m.id === wantId);
    if (!hit) {
      return jsonResponse({ success: false, error: "模型不存在：" + wantId }, 404);
    }
    const result = await callModel(env, hit, message, lang);
    return jsonResponse(
      {
        success: !!result.ok,
        reply: result.reply || "",
        latencyMs: result.latencyMs,
        upstreamStatus: result.status,
        error: result.error || null,
        model: modelMeta(hit, "manual", { lang }),
        upstream: result.ok ? undefined : result.data,
      },
      result.ok ? 200 : 502
    );
  }

  // Auto：第一梯队主→备，再 registry
  const { candidates, lang: uiLang } = tier1Candidates(env, lang);
  const attempts = [];

  for (const cand of candidates) {
    const via =
      "auto→tier1/" +
      (cand.preference || "primary") +
      "/" +
      (cand.role || cand.label);
    const result = await callModel(env, cand, message, uiLang);
    attempts.push({
      label: cand.label,
      modelId: cand.modelId,
      preference: cand.preference,
      ok: !!result.ok,
      error: result.error || null,
      latencyMs: result.latencyMs,
    });
    if (result.ok) {
      return jsonResponse({
        success: true,
        reply: result.reply || "",
        latencyMs: result.latencyMs,
        upstreamStatus: result.status,
        error: null,
        model: modelMeta(cand, via, { lang: uiLang }),
        attempts,
      });
    }
  }

  const fallback = pickRegistryFallback(env, models);
  if (fallback.target) {
    const result = await callModel(env, fallback.target, message, uiLang);
    attempts.push({
      label: fallback.target.label,
      modelId: fallback.target.modelId,
      preference: "registry",
      ok: !!result.ok,
      error: result.error || null,
      latencyMs: result.latencyMs,
    });
    return jsonResponse(
      {
        success: !!result.ok,
        reply: result.reply || "",
        latencyMs: result.latencyMs,
        upstreamStatus: result.status,
        error: result.error || null,
        model: modelMeta(fallback.target, fallback.via, { lang: uiLang }),
        attempts,
        upstream: result.ok ? undefined : result.data,
      },
      result.ok ? 200 : 502
    );
  }

  return jsonResponse(
    {
      success: false,
      error:
        "Auto 未找到可用模型（中文首选 Doubao / 英文首选 Qwen；请检查 ARK_API_KEY、SILICONFLOW_API_KEY 与模型环境变量）",
      model: { id: "auto", label: "Auto", modelId: "", tier: 0, via: "auto→none", lang: uiLang },
      attempts,
    },
    400
  );
}
