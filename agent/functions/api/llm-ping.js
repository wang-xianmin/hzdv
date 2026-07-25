/**
 * POST /api/llm-ping
 * 试通某一模型（OpenAI 兼容）。
 *
 * Body:
 *   { phone, id }                    // 模型库里的 id
 *   { phone, builtin: "doubao-lite" | "siliconflow-lite" }
 */

import { assertOpsAccess, opsAuthErrorResponse } from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import { pickKvBinding, kvBindingHint } from "../lib/host.js";
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

function builtinTarget(env, name) {
  const n = String(name || "").trim();
  if (n === "doubao-lite" || n === "doubao") {
    return {
      label: "Doubao-1.5-lite-32k",
      modelId: String(env.DOUBAO_LITE_MODEL || "").trim(),
      baseUrl: String(env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").trim(),
      apiKeyEnv: "ARK_API_KEY",
      tier: 1,
    };
  }
  if (n === "siliconflow-lite" || n === "qwen-lite" || n === "qwen") {
    return {
      label: "Qwen/Qwen2.5-7B-Instruct",
      modelId: String(env.QWEN_LITE_MODEL || "Qwen/Qwen2.5-7B-Instruct").trim(),
      baseUrl: String(
        env.QWEN_BASE_URL || env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"
      ).trim(),
      apiKeyEnv: "SILICONFLOW_API_KEY",
      tier: 1,
    };
  }
  return null;
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

  let target = null;
  if (body.builtin) {
    target = builtinTarget(env, body.builtin);
    if (!target || !target.modelId || !target.baseUrl) {
      return jsonResponse(
        {
          success: false,
          error:
            "内置模型未配全。豆包需 ARK_API_KEY + DOUBAO_LITE_MODEL；硅基需 SILICONFLOW_API_KEY + QWEN_BASE_URL + QWEN_LITE_MODEL",
        },
        400
      );
    }
  } else {
    const id = String(body.id || "").trim();
    if (!id) return jsonResponse({ success: false, error: "缺少 id 或 builtin" }, 400);
    const kv = pickKvBinding(env);
    if (!kv) {
      return jsonResponse({ success: false, error: "KV not configured", hint: kvBindingHint() }, 503);
    }
    const { models } = await loadLlmModels(kv);
    const hit = (models || []).find((m) => m.id === id);
    if (!hit) return jsonResponse({ success: false, error: "模型不存在" }, 404);
    target = hit;
  }

  if (String(target.baseUrl || "").includes("{WorkspaceId}")) {
    return jsonResponse(
      {
        success: false,
        error: "baseUrl 仍含 {WorkspaceId}，请改成真实业务空间地址后再试",
        target: {
          label: target.label,
          modelId: target.modelId,
          baseUrl: target.baseUrl,
          apiKeyEnv: target.apiKeyEnv,
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
        error: "环境变量未配置或为空：" + (target.apiKeyEnv || "(未填 apiKeyEnv)"),
        target: {
          label: target.label,
          modelId: target.modelId,
          baseUrl: target.baseUrl,
          apiKeyEnv: target.apiKeyEnv,
        },
      },
      400
    );
  }

  const prompt =
    String(body.prompt || "").trim() ||
    "请只回复：pong。不要输出其它内容。";

  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      { role: "system", content: "你是连通性测试助手。" },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 64,
    timeoutMs: 45000,
  });

  const reply = extractAssistantText(result.data);
  return jsonResponse(
    {
      success: !!result.ok,
      latencyMs: result.latencyMs,
      reply: reply || "",
      upstreamStatus: result.status,
      error: result.error || null,
      target: {
        id: target.id || null,
        label: target.label,
        modelId: target.modelId,
        baseUrl: target.baseUrl,
        apiKeyEnv: target.apiKeyEnv,
        tier: target.tier,
      },
      upstream: result.ok ? undefined : result.data,
    },
    result.ok ? 200 : 502
  );
}
