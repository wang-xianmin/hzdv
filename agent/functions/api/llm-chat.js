/**
 * POST /api/llm-chat
 * 最小对话入口（调试用）：按所选模型或 Auto 解析后的模型调用 OpenAI 兼容接口。
 *
 * Body: { phone, message, modelId?: "auto" | <registry id> }
 * Returns: { success, reply, model: { id, label, modelId, tier, via }, latencyMs, error? }
 *
 * Auto 当前规则（分类器接入前）：
 *   1) 第二梯队第一个已启用且有 Key 的模型
 *   2) 否则第三梯队同上
 *   3) 否则内置 Doubao-lite / SiliconFlow-lite
 */

import { assertOpsAccess, opsAuthErrorResponse, pickKvBinding, kvBindingHint } from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function builtinCandidates(env) {
  const list = [];
  const doubaoModel = String(env.DOUBAO_LITE_MODEL || "").trim();
  const doubaoBase = String(
    env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"
  ).trim();
  if (doubaoModel && doubaoBase && resolveApiKey(env, "ARK_API_KEY")) {
    list.push({
      id: "builtin:doubao-lite",
      label: "Doubao-1.5-lite",
      modelId: doubaoModel,
      baseUrl: doubaoBase,
      apiKeyEnv: "ARK_API_KEY",
      tier: 1,
    });
  }
  const qwenModel = String(env.QWEN_LITE_MODEL || "").trim();
  const qwenBase = String(env.QWEN_BASE_URL || env.SILICONFLOW_BASE_URL || "").trim();
  if (qwenModel && qwenBase && resolveApiKey(env, "SILICONFLOW_API_KEY")) {
    list.push({
      id: "builtin:siliconflow-lite",
      label: "Qwen2.5-7B (SiliconFlow)",
      modelId: qwenModel,
      baseUrl: qwenBase,
      apiKeyEnv: "SILICONFLOW_API_KEY",
      tier: 1,
    });
  }
  return list;
}

function pickAutoTarget(env, models) {
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

  const builtins = builtinCandidates(env);
  if (builtins.length) {
    return { target: builtins[0], via: "auto→builtin" };
  }
  return { target: null, via: "auto→none" };
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

  const wantId = String(body.modelId || body.model || "auto").trim() || "auto";
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse({ success: false, error: "KV not configured", hint: kvBindingHint() }, 503);
  }

  const { models } = await loadLlmModels(kv);
  let target = null;
  let via = "manual";

  if (wantId === "auto") {
    const picked = pickAutoTarget(env, models);
    target = picked.target;
    via = picked.via;
  } else {
    const hit = (models || []).find((m) => m.id === wantId);
    if (!hit) {
      return jsonResponse({ success: false, error: "模型不存在：" + wantId }, 404);
    }
    target = hit;
    via = "manual";
  }

  if (!target) {
    return jsonResponse(
      {
        success: false,
        error: "Auto 未找到可用模型（检查梯队启用状态与对应 API Key 环境变量）",
        model: { id: "auto", label: "Auto", modelId: "", tier: 0, via },
      },
      400
    );
  }

  if (String(target.baseUrl || "").includes("{WorkspaceId}")) {
    return jsonResponse(
      {
        success: false,
        error: "baseUrl 仍含 {WorkspaceId}",
        model: {
          id: target.id,
          label: target.label,
          modelId: target.modelId,
          tier: target.tier,
          via,
        },
      },
      400
    );
  }

  const apiKey = resolveApiKey(env, target.apiKeyEnv);
  if (!apiKey) {
    return jsonResponse(
      {
        success: false,
        error: "环境变量未配置：" + (target.apiKeyEnv || "(空)"),
        model: {
          id: target.id,
          label: target.label,
          modelId: target.modelId,
          tier: target.tier,
          via,
        },
      },
      400
    );
  }

  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      {
        role: "system",
        content: "你是 HZDV 站点助手。回答简洁、直接。若用户用中文则用中文回复。",
      },
      { role: "user", content: message },
    ],
    temperature: 0.3,
    max_tokens: 1024,
    timeoutMs: 60000,
  });

  const reply = extractAssistantText(result.data);
  const modelMeta = {
    id: target.id || null,
    label: target.label || target.modelId,
    modelId: target.modelId,
    tier: target.tier,
    via,
    apiKeyEnv: target.apiKeyEnv,
  };

  return jsonResponse(
    {
      success: !!result.ok,
      reply: reply || "",
      latencyMs: result.latencyMs,
      upstreamStatus: result.status,
      error: result.error || null,
      model: modelMeta,
      upstream: result.ok ? undefined : result.data,
    },
    result.ok ? 200 : 502
  );
}
