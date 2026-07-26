/**
 * 语言工具 + 旧内置第一梯队描述（仅 /api/llm-ping 的 builtin 试通还在用）。
 *
 * 第一梯队选模已迁入 KV 模型库（见 llm-models-store.js），
 * 不再按菜单语言定主备；回复语言仍由提问语言决定（detectTextLang）。
 */

import { resolveApiKey } from "./openai-compat.js";

export function normalizeUiLang(lang) {
  const s = String(lang || "").trim().toLowerCase();
  if (s === "en" || s.indexOf("en") === 0) return "en";
  return "zh";
}

/** 提问语言：含中日韩字符判为中文，含拉丁字母判为英文，否则回落菜单语言 */
export function detectTextLang(text, fallbackLang) {
  const s = String(text || "");
  if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return "zh";
  if (/[A-Za-z]/.test(s)) return "en";
  return normalizeUiLang(fallbackLang);
}

const DOUBAO_DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const QWEN_DEFAULT_BASE = "https://api.siliconflow.cn/v1";
const QWEN_DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct";

const DOUBAO_DEFAULT_LABEL = "Doubao-Seed-2.0-lite";

/**
 * 模型标识可填方舟接入点 ID（ep-…）或公开型号名。
 * 变量名兼容历史：DOUBAO_SEED_MODEL → DOUBAO_MODEL → DOUBAO_LITE_MODEL
 */
function doubaoModelId(env) {
  return String(
    env.DOUBAO_SEED_MODEL || env.DOUBAO_MODEL || env.DOUBAO_LITE_MODEL || ""
  ).trim();
}

/** @returns {{ role: string, label: string, target: object|null, missing: string[] }} */
export function describeDoubao(env) {
  const modelId = doubaoModelId(env);
  const baseUrl = String(env.DOUBAO_BASE_URL || DOUBAO_DEFAULT_BASE).trim();
  const label = String(env.DOUBAO_LABEL || DOUBAO_DEFAULT_LABEL).trim();
  const missing = [];
  if (!modelId) missing.push("DOUBAO_SEED_MODEL");
  if (!baseUrl) missing.push("DOUBAO_BASE_URL");
  if (!resolveApiKey(env, "ARK_API_KEY")) missing.push("ARK_API_KEY");

  return {
    role: "doubao",
    label,
    missing,
    target: missing.length
      ? null
      : {
          id: "builtin:doubao-lite",
          label,
          modelId,
          baseUrl,
          apiKeyEnv: "ARK_API_KEY",
          tier: 1,
          role: "doubao",
        },
  };
}

/** @returns {{ role: string, label: string, target: object|null, missing: string[] }} */
export function describeQwen(env) {
  const modelId = String(env.QWEN_LITE_MODEL || QWEN_DEFAULT_MODEL).trim();
  const baseUrl = String(
    env.QWEN_BASE_URL || env.SILICONFLOW_BASE_URL || QWEN_DEFAULT_BASE
  ).trim();
  const missing = [];
  if (!resolveApiKey(env, "SILICONFLOW_API_KEY")) missing.push("SILICONFLOW_API_KEY");

  return {
    role: "qwen",
    label: QWEN_DEFAULT_MODEL,
    missing,
    target: missing.length
      ? null
      : {
          id: "builtin:siliconflow-lite",
          label: QWEN_DEFAULT_MODEL,
          modelId,
          baseUrl,
          apiKeyEnv: "SILICONFLOW_API_KEY",
          tier: 1,
          role: "qwen",
        },
  };
}

