/**
 * 第一梯队（分类器 / 前锋）选模
 *
 * 中文 UI：Doubao-1.5-lite 首选，Qwen2.5-7B 备选
 * 英文 UI：Qwen2.5-7B 首选，Doubao-1.5-lite 备选
 */

import { resolveApiKey } from "./openai-compat.js";

export function normalizeUiLang(lang) {
  const s = String(lang || "").trim().toLowerCase();
  if (s === "en" || s.indexOf("en") === 0) return "en";
  return "zh";
}

export function getDoubaoLite(env) {
  const modelId = String(env.DOUBAO_LITE_MODEL || "").trim();
  const baseUrl = String(
    env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"
  ).trim();
  if (!modelId || !baseUrl || !resolveApiKey(env, "ARK_API_KEY")) return null;
  return {
    id: "builtin:doubao-lite",
    label: "Doubao-1.5-lite-32k",
    modelId,
    baseUrl,
    apiKeyEnv: "ARK_API_KEY",
    tier: 1,
    role: "doubao",
  };
}

export function getQwenLite(env) {
  const modelId = String(
    env.QWEN_LITE_MODEL || "Qwen/Qwen2.5-7B-Instruct"
  ).trim();
  const baseUrl = String(
    env.QWEN_BASE_URL || env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"
  ).trim();
  if (!modelId || !baseUrl || !resolveApiKey(env, "SILICONFLOW_API_KEY")) return null;
  return {
    id: "builtin:siliconflow-lite",
    label: "Qwen/Qwen2.5-7B-Instruct",
    modelId,
    baseUrl,
    apiKeyEnv: "SILICONFLOW_API_KEY",
    tier: 1,
    role: "qwen",
  };
}

/**
 * @returns {{ primary: object|null, backup: object|null, order: string[], lang: "zh"|"en" }}
 */
export function tier1Order(env, lang) {
  const ui = normalizeUiLang(lang);
  const doubao = getDoubaoLite(env);
  const qwen = getQwenLite(env);
  if (ui === "en") {
    return {
      lang: "en",
      primary: qwen,
      backup: doubao,
      order: ["qwen", "doubao"],
    };
  }
  return {
    lang: "zh",
    primary: doubao,
    backup: qwen,
    order: ["doubao", "qwen"],
  };
}

/** 按语言返回可用的第一梯队列表（主→备，已过滤未配置） */
export function tier1Candidates(env, lang) {
  const { primary, backup, lang: ui } = tier1Order(env, lang);
  const list = [];
  if (primary) list.push({ ...primary, preference: "primary" });
  if (backup && (!primary || backup.id !== primary.id)) {
    list.push({ ...backup, preference: "backup" });
  }
  return { lang: ui, candidates: list };
}
