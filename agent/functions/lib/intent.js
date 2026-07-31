/**
 * 意图分类器（VPS 上的 llama.cpp + Qwen2.5-1.5B-Instruct）
 *
 * 作用：Auto 模式下先给用户消息定级，再路由到对应梯队：
 *   tier1 闲聊/简单问答
 *   tier2 常规任务
 *   tier3 复杂推理/长文/代码
 * 若需要实时/网上材料，可附带 web（如 tier2 web）。
 *
 * 依赖环境变量：
 *   INTENT_SERVICE_URL  例：http://ocr.hzdv.net:8090/v1
 *   INTENT_API_KEY      services/intent/.intent_api_key 的内容
 *
 * 未配置或调用失败时返回 tier=null，调用方回退为原有 tier1 主备逻辑。
 */

import { chatCompletions, extractAssistantText } from "./openai-compat.js";

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

function parseClassify(text) {
  const s = String(text || "").toLowerCase();
  const m = s.match(/tier\s*([123])/);
  const tier = m ? Number(m[1]) : null;
  const web = /\bweb\b/.test(s) || /联网|搜网/.test(s);
  return { tier, web: !!(tier && web) };
}

/**
 * @returns {Promise<{ tier: 1|2|3|null, web: boolean, latencyMs: number, error: string|null }>}
 */
export async function classifyIntent(env, message) {
  const target = intentTarget(env);
  if (!target) {
    return {
      tier: null,
      web: false,
      latencyMs: 0,
      error: "分类器未配置（INTENT_SERVICE_URL / INTENT_API_KEY）",
    };
  }
  const result = await chatCompletions({
    baseUrl: target.baseUrl,
    apiKey: String(env.INTENT_API_KEY || "").trim(),
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
    max_tokens: 10,
    timeoutMs: 6000,
    extraBody: { cache_prompt: true },
  });
  if (!result.ok) {
    return {
      tier: null,
      web: false,
      latencyMs: result.latencyMs,
      error: result.error || "分类器调用失败",
    };
  }
  const parsed = parseClassify(extractAssistantText(result.data));
  if (!parsed.tier) {
    return {
      tier: null,
      web: false,
      latencyMs: result.latencyMs,
      error: "分类器输出无法解析",
    };
  }
  return {
    tier: parsed.tier,
    web: parsed.web,
    latencyMs: result.latencyMs,
    error: null,
  };
}
