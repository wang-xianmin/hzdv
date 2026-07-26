/**
 * 意图分类器（VPS 上的 llama.cpp + Qwen2.5-1.5B-Instruct）
 *
 * 作用：Auto 模式下先给用户消息定级，再路由到对应梯队：
 *   tier1 闲聊/简单问答（内置 Doubao / Qwen 主备）
 *   tier2 常规任务（模型库第二梯队）
 *   tier3 复杂推理/长文/代码（模型库第三梯队）
 *
 * 依赖环境变量：
 *   INTENT_SERVICE_URL  例：http://ocr.hzdv.net:8090/v1（必须域名，Workers 不能 fetch 裸 IP）
 *   INTENT_API_KEY      services/intent/.intent_api_key 的内容
 *
 * 未配置或调用失败时返回 tier=null，调用方回退为原有 tier1 主备逻辑。
 */

import { chatCompletions, extractAssistantText } from "./openai-compat.js";

// 1.5B 小模型必须配 few-shot 才稳（实测裸提示 5/8，few-shot 9/9）
const CLASSIFY_PROMPT =
  "你是路由分类器，给用户消息分级，只输出 tier1、tier2 或 tier3。\n" +
  "tier1：打招呼、闲聊、寒暄、一两个词的简单提问。\n" +
  "tier2：有明确任务的常规请求：翻译、总结、改写、解释概念、一般知识问答、网站使用/功能咨询。\n" +
  "tier3：需要多步推理或长输出：数学证明、编程、代码调试、长文分析、方案规划、学习路线。\n" +
  "只输出 tier1 / tier2 / tier3。";

const FEW_SHOT = [
  ["你好", "tier1"],
  ["hello, how are you", "tier1"],
  ["帮我把这段话翻译成英文：今天天气不错", "tier2"],
  ["什么是量子纠缠？", "tier2"],
  ["网站上怎么切换语言", "tier2"],
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

function parseTier(text) {
  const m = String(text || "").toLowerCase().match(/tier\s*([123])/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {Promise<{ tier: 1|2|3|null, latencyMs: number, error: string|null }>}
 */
export async function classifyIntent(env, message) {
  const target = intentTarget(env);
  if (!target) {
    return { tier: null, latencyMs: 0, error: "分类器未配置（INTENT_SERVICE_URL / INTENT_API_KEY）" };
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
    max_tokens: 8,
    timeoutMs: 6000,
  });
  if (!result.ok) {
    return { tier: null, latencyMs: result.latencyMs, error: result.error || "分类器调用失败" };
  }
  const tier = parseTier(extractAssistantText(result.data));
  if (!tier) {
    return { tier: null, latencyMs: result.latencyMs, error: "分类器输出无法解析" };
  }
  return { tier, latencyMs: result.latencyMs, error: null };
}
