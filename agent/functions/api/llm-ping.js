/**
 * POST /api/llm-ping
 * 试通某一模型（OpenAI 兼容）。
 *
 * Body:
 *   { phone, id }                    // 模型库里的 id
 *   { phone, builtin: "doubao-lite" | "doubao-seed" | "siliconflow-lite" | "intent" }
 */

import { assertOpsAccess, opsAuthErrorResponse } from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import { pickKvBinding, kvBindingHint } from "../lib/host.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";
import { describeDoubao, describeQwen } from "../lib/tier1.js";
import { intentTarget } from "../lib/intent.js";
import { resolveGenerateProxy } from "../lib/route-mode.js";

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
  if (n === "intent" || n === "classifier") {
    return (
      intentTarget(env) || {
        label: "Qwen2.5-1.5B 分类器",
        modelId: "",
        baseUrl: "",
        apiKeyEnv: "INTENT_API_KEY",
        tier: 0,
      }
    );
  }
  const desc =
    n === "doubao-lite" || n === "doubao" || n === "doubao-seed"
      ? describeDoubao(env)
      : n === "siliconflow-lite" || n === "qwen-lite" || n === "qwen"
        ? describeQwen(env)
        : null;
  if (!desc) return null;
  if (desc.target) return desc.target;
  return { label: desc.label, modelId: "", baseUrl: "", apiKeyEnv: "", tier: 1 };
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
            "内置模型未配全。豆包需 ARK_API_KEY + DOUBAO_SEED_MODEL（填接入点 ep-… 或型号名）；硅基需 SILICONFLOW_API_KEY；分类器需 INTENT_SERVICE_URL + INTENT_API_KEY",
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
    const { models } = await loadLlmModels(kv, env);
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

  /** 意图分类器已在 VPS，勿再套 llm-proxy；方案二 / CF 模式一律直连云端 */
  const isIntent =
    String(body.builtin || "") === "intent" ||
    String(body.builtin || "") === "classifier" ||
    String(target.apiKeyEnv || "") === "INTENT_API_KEY";
  const proxy = isIntent
    ? null
    : resolveGenerateProxy(
        env,
        body.systemSettings || body.system_settings || {}
      );

  const result = await chatCompletions({
    baseUrl: proxy ? proxy.baseUrl : target.baseUrl,
    apiKey: proxy ? proxy.apiKey : apiKey,
    upstreamBaseUrl: proxy ? target.baseUrl : null,
    upstreamApiKey: proxy ? apiKey : null,
    model: target.modelId,
    messages: [
      { role: "system", content: "你是连通性测试助手。" },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 64,
    timeoutMs: proxy ? 90000 : 45000,
  });

  const reply = extractAssistantText(result.data);
  return jsonResponse(
    {
      success: !!result.ok,
      latencyMs: result.latencyMs,
      reply: reply || "",
      upstreamStatus: result.status,
      error: result.error || null,
      viaProxy: !!proxy,
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
