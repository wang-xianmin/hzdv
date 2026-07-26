/**
 * 第一梯队（分类器 / 前锋）选模
 *
 * 菜单语言决定主备顺序：
 *   中文 UI：Doubao 首选，Qwen2.5-7B 备选
 *   英文 UI：Qwen2.5-7B 首选，Doubao 备选
 *
 * 注意：主备顺序只看菜单语言；回复语言由提问语言决定（见 detectTextLang）。
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

/**
 * 运维列表用：始终返回 Doubao / Qwen 两张卡片（含缺配置原因），不因缺 Key 而隐藏。
 */
export function tier1Catalog(env) {
  return [describeDoubao(env), describeQwen(env)].map((desc) => {
    const t = desc.target;
    return {
      id: t ? t.id : "builtin:" + desc.role,
      label: desc.label,
      modelId: t ? t.modelId : "",
      baseUrl: t ? t.baseUrl : "",
      apiKeyEnv: desc.role === "doubao" ? "ARK_API_KEY" : "SILICONFLOW_API_KEY",
      tier: 1,
      role: desc.role,
      builtin: desc.role === "doubao" ? "doubao-lite" : "siliconflow-lite",
      ready: !!t,
      missing: desc.missing || [],
      caps: { text: true, vision: false, video: false, ocr: false },
      notes:
        desc.role === "doubao"
          ? "中文菜单首选 · 英文菜单备选"
          : "英文菜单首选 · 中文菜单备选",
      notesEn:
        desc.role === "doubao"
          ? "Primary for ZH menu · backup for EN"
          : "Primary for EN menu · backup for ZH",
    };
  });
}

/**
 * 按菜单语言排出第一梯队主备。
 * @returns {{ lang: "zh"|"en", primary: object, backup: object, candidates: object[], skipped: object[] }}
 */
export function tier1Plan(env, lang) {
  const ui = normalizeUiLang(lang);
  const doubao = describeDoubao(env);
  const qwen = describeQwen(env);
  const primary = ui === "en" ? qwen : doubao;
  const backup = ui === "en" ? doubao : qwen;

  const candidates = [];
  const skipped = [];
  [
    { desc: primary, preference: "primary" },
    { desc: backup, preference: "backup" },
  ].forEach(({ desc, preference }) => {
    if (desc.target) {
      candidates.push({ ...desc.target, preference });
    } else {
      skipped.push({
        label: desc.label,
        role: desc.role,
        preference,
        missing: desc.missing,
      });
    }
  });

  return { lang: ui, primary, backup, candidates, skipped };
}
