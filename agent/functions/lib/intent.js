/**
 * 意图分类器
 *
 * 方案一（vps）：VPS llama.cpp + Qwen2.5-1.5B
 *   INTENT_SERVICE_URL / INTENT_API_KEY
 * 方案二（cf）：CF 直调云端 7B（优先模型库 Qwen2.5-7B / 否则 SILICONFLOW）
 *
 * 输出：tier1|tier2|tier3，可选 web
 */

import { chatCompletions, extractAssistantText, resolveApiKey } from "./openai-compat.js";
import { resolveRouteMode } from "./route-mode.js";

const CLASSIFY_PROMPT =
  "你是路由分类器。给用户消息分级，只输出一行：tier1、tier2、tier3，需要联网时在后面加空格和 web。\n" +
  "tier1：打招呼、闲聊、寒暄。\n" +
  "tier2：常规任务：翻译、总结、解释、一般知识、网站功能咨询。\n" +
  "tier3：多步推理/长文/编程/方案规划。\n" +
  "web：必须查最新新闻、实时数据、股价、天气、赛果、刚发布的产品信息等；纯概念解释不要加 web。\n" +
  "示例输出：tier1 / tier2 / tier3 / tier2 web / tier3 web";

const FEW_SHOT = [
  ["你好", "tier1"],
  ["hello, how are you", "tier1"],
  ["帮我把这段话翻译成英文：今天天气不错", "tier2"],
  ["什么是量子纠缠？", "tier2"],
  ["网站上怎么切换语言", "tier2"],
  ["今天有什么科技新闻", "tier2 web"],
  ["苹果现在股价多少", "tier2 web"],
  ["latest OpenAI model release news", "tier2 web"],
  ["写一个 Python 快速排序并解释时间复杂度", "tier3"],
  ["帮我规划一个三个月的机器学习学习路线", "tier3"],
];

export function intentTarget(env) {
  const baseUrl = String(env.INTENT_SERVICE_URL || "").trim();
  const apiKey = String(env.INTENT_API_KEY || "").trim();
  if (!baseUrl || !apiKey) return null;
  return {
    id: "builtin:intent",
    label: "Qwen2.5-1.5B 分类器",
    modelId: "qwen2.5-1.5b-instruct",
    baseUrl,
    apiKeyEnv: "INTENT_API_KEY",
    tier: 0,
  };
}

/** CF 模式：意图用云端 7B（优先库内 Qwen2.5-7B） */
export function cloudIntentTarget(env, models) {
  const enabled = (models || []).filter((m) => m && m.enabled !== false);
  const scored = enabled
    .filter((m) => m.modelId && m.baseUrl && resolveApiKey(env, m.apiKeyEnv))
    .map((m) => {
      const id = String(m.modelId || "").toLowerCase();
      const label = String(m.label || "").toLowerCase();
      let score = 0;
      if (/qwen2\.5-7b/.test(id) || /qwen2\.5-7b/.test(label)) score = 100;
      else if (m.tier === 1) score = 50 - (m.order || 0);
      else if (m.tier === 2) score = 20 - (m.order || 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    const m = scored[0].m;
    return {
      id: m.id || "cloud-intent",
      label: (m.label || m.modelId) + "（CF意图）",
      modelId: m.modelId,
      baseUrl: m.baseUrl,
      apiKeyEnv: m.apiKeyEnv,
      tier: m.tier || 1,
    };
  }
  const apiKey = resolveApiKey(env, "SILICONFLOW_API_KEY");
  if (!apiKey) return null;
  return {
    id: "builtin:cloud-intent-7b",
    label: "Qwen2.5-7B-Instruct（CF意图）",
    modelId: String(
      env.QWEN_LITE_MODEL || "Qwen/Qwen2.5-7B-Instruct"
    ).trim(),
    baseUrl: String(
      env.QWEN_BASE_URL ||
        env.SILICONFLOW_BASE_URL ||
        "https://api.siliconflow.cn/v1"
    ).trim(),
    apiKeyEnv: "SILICONFLOW_API_KEY",
    tier: 1,
  };
}

function parseClassify(text) {
  const s = String(text || "").toLowerCase();
  const m = s.match(/tier\s*([123])/);
  const tier = m ? Number(m[1]) : null;
  const web = /\bweb\b/.test(s) || /联网|搜网/.test(s);
  return { tier, web: !!(tier && web) };
}

/**
 * @param {object} [opts]
 * @param {"vps"|"cf"} [opts.routeMode]
 * @param {object[]} [opts.models]  CF 模式选 7B 用
 * @returns {Promise<{
 *   tier: 1|2|3|null,
 *   web: boolean,
 *   latencyMs: number,
 *   error: string|null,
 *   raw?: string,
 *   via?: string,
 *   label?: string,
 * }>}
 */
export async function classifyIntent(env, message, opts) {
  const routeMode =
    (opts && opts.routeMode) ||
    resolveRouteMode(opts && opts.systemSettings, env, {
      country: opts && opts.country,
    });

  let target = null;
  let apiKey = "";
  let timeoutMs = 6000;
  let extraBody = { cache_prompt: true };
  let via = "vps→1.5B";

  if (routeMode === "cf") {
    target = cloudIntentTarget(env, (opts && opts.models) || []);
    if (!target) {
      return {
        tier: null,
        web: false,
        latencyMs: 0,
        error:
          "CF 模式意图未配置（需模型库 Qwen2.5-7B 或 SILICONFLOW_API_KEY）",
        raw: "",
        via: "cf→7B",
      };
    }
    apiKey = resolveApiKey(env, target.apiKeyEnv);
    timeoutMs = 25000;
    extraBody = null;
    via = "cf→7B";
  } else {
    target = intentTarget(env);
    if (!target) {
      return {
        tier: null,
        web: false,
        latencyMs: 0,
        error: "分类器未配置（INTENT_SERVICE_URL / INTENT_API_KEY）",
        raw: "",
        via: "vps→1.5B",
      };
    }
    apiKey = String(env.INTENT_API_KEY || "").trim();
    via = "vps→1.5B";
  }

  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey,
    model: target.modelId,
    messages: [
      { role: "system", content: CLASSIFY_PROMPT },
      ...FEW_SHOT.flatMap(([u, a]) => [
        { role: "user", content: u },
        { role: "assistant", content: a },
      ]),
      { role: "user", content: String(message || "").slice(0, 800) },
    ],
    temperature: 0,
    max_tokens: 16,
    timeoutMs,
    extraBody,
    // CF 模式禁止经 VPS 代理
    upstreamBaseUrl: null,
    upstreamApiKey: null,
  });

  if (!result.ok) {
    return {
      tier: null,
      web: false,
      latencyMs: result.latencyMs,
      error: result.error || "分类器调用失败",
      raw: "",
      via,
      label: target.label,
    };
  }
  const raw = String(extractAssistantText(result.data) || "").trim();
  const parsed = parseClassify(raw);
  if (!parsed.tier) {
    return {
      tier: null,
      web: false,
      latencyMs: result.latencyMs,
      error: "分类器输出无法解析",
      raw,
      via,
      label: target.label,
    };
  }
  return {
    tier: parsed.tier,
    web: parsed.web,
    latencyMs: result.latencyMs,
    error: null,
    raw,
    via,
    label: target.label,
  };
}
