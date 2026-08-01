/**
 * LLM 模型注册表（KV）
 * - tier: 1 | 2 | 3（三个梯队全部在此表，可编辑排序）
 * - order: 同梯队内越小越优先
 * - caps: text / vision / video / ocr
 * - apiKeyEnv: Pages 环境变量名（不存真实密钥）
 */

export const LLM_MODELS_KV_KEY = "hzdv:llm_models_v1";

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 第一梯队默认条目。优先取环境变量（兼容原内置配置），没有则用公开默认值。
 * 迁移用：老库里没有 tier1 模型时自动补上这两条。
 */
export function tier1DefaultModels(env) {
  const e = env || {};
  const doubaoModelId = String(
    e.DOUBAO_SEED_MODEL || e.DOUBAO_MODEL || e.DOUBAO_LITE_MODEL || "doubao-seed-2.0-lite"
  ).trim();
  return [
    {
      label: "Qwen/Qwen2.5-7B-Instruct",
      modelId: String(e.QWEN_LITE_MODEL || "Qwen/Qwen2.5-7B-Instruct").trim(),
      baseUrl: String(
        e.QWEN_BASE_URL || e.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"
      ).trim(),
      apiKeyEnv: "SILICONFLOW_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: String(e.DOUBAO_LABEL || "Doubao-Seed-2.0-lite").trim(),
      modelId: doubaoModelId,
      baseUrl: String(e.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").trim(),
      apiKeyEnv: "ARK_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
  ].map((m, i) => normalizeModel({ ...m, tier: 1, order: i }));
}

export function defaultLlmModelsSeed(env) {
  const t1 = tier1DefaultModels(env);
  const t2 = [
    {
      label: "qwen3.7-max",
      modelId: "qwen3.7-max",
      baseUrl: "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      enabled: false,
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "qwen3.7-plus",
      modelId: "qwen3.7-plus",
      baseUrl: "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "glm-5",
      modelId: "glm-5",
      baseUrl: "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "deepseek-v4-flash",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "DeepSeek-V4-Flash (SiliconFlow)",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKeyEnv: "SILICONFLOW_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "Qwen-VL-OCR",
      modelId: "Qwen-VL-OCR",
      baseUrl:
        "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: true, video: false, ocr: true },
    },
    {
      label: "Qwen-VL-Max",
      modelId: "Qwen-VL-Max",
      baseUrl:
        "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: true, video: false, ocr: false },
    },
  ].map((m, i) => normalizeModel({ ...m, tier: 2, order: i }));

  const t3 = [
    {
      label: "qwen3-vl-235b-thinking",
      modelId: "qwen3-vl-235b-a22b-thinking",
      baseUrl:
        "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: true, video: true, ocr: false },
    },
    {
      label: "qwen3-vl-32b/30b-thinking",
      modelId: "qwen3-vl-32b-thinking",
      baseUrl:
        "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: true, video: true, ocr: false },
    },
  ].map((m, i) => normalizeModel({ ...m, tier: 3, order: i }));

  return [...t1, ...t2, ...t3];
}

export function normalizeCaps(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    text: c.text !== false,
    vision: !!c.vision,
    video: !!c.video,
    ocr: !!c.ocr,
  };
}

function looksLikeEnvName(s) {
  return /^[A-Z][A-Z0-9_]*$/.test(String(s || "").trim());
}

function looksLikeUrl(s) {
  const t = String(s || "").trim();
  return /^https?:\/\//i.test(t) || t.includes("://");
}

/** 根据 baseUrl 猜密钥环境变量名（纠错用，不覆盖已正确填写的） */
export function inferApiKeyEnvFromBaseUrl(baseUrl) {
  const u = String(baseUrl || "").toLowerCase();
  if (!u) return "";
  if (u.includes("aliyuncs.com") || u.includes("dashscope")) {
    return "ALIYUN_MAAS_API_KEY";
  }
  if (u.includes("siliconflow")) return "SILICONFLOW_API_KEY";
  if (u.includes("deepseek.com")) return "DEEPSEEK_API_KEY";
  if (u.includes("volces.com") || u.includes("ark.cn-")) return "ARK_API_KEY";
  if (u.includes("deepseek")) return "DEEPSEEK_API_KEY";
  return "";
}

/**
 * 纠错：有人把 Base URL 填进「密钥环境变量」栏（或两栏对调）。
 * 在内存里修好，避免总结阶段误报「缺密钥 https://…」。
 */
export function healModelKeyUrlFields(baseUrl, apiKeyEnv) {
  let base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  let keyEnv = String(apiKeyEnv || "").trim();

  if (looksLikeUrl(keyEnv)) {
    if (!base || looksLikeEnvName(base)) {
      const prevBase = base;
      base = keyEnv.replace(/\/+$/, "");
      keyEnv = looksLikeEnvName(prevBase)
        ? prevBase
        : inferApiKeyEnvFromBaseUrl(base);
    } else {
      // baseUrl 已是 URL，apiKeyEnv 误贴了另一份 URL → 按 base 推断密钥名
      keyEnv = inferApiKeyEnvFromBaseUrl(base) || inferApiKeyEnvFromBaseUrl(keyEnv);
    }
  } else if (!keyEnv && base) {
    keyEnv = inferApiKeyEnvFromBaseUrl(base);
  }

  return { baseUrl: base, apiKeyEnv: keyEnv };
}

export function normalizeModel(raw) {
  const rawTier = Number(raw && raw.tier);
  const tier = rawTier === 1 ? 1 : rawTier === 3 ? 3 : 2;
  const order = Math.max(0, Math.floor(Number(raw && raw.order) || 0));
  const healed = healModelKeyUrlFields(
    raw && raw.baseUrl,
    raw && raw.apiKeyEnv
  );
  return {
    id: String((raw && raw.id) || uid()),
    label: String((raw && (raw.label || raw.name || raw.modelId)) || "").trim() || "unnamed",
    modelId: String((raw && (raw.modelId || raw.model)) || "").trim(),
    baseUrl: healed.baseUrl,
    apiKeyEnv: healed.apiKeyEnv,
    tier,
    order,
    enabled: raw && raw.enabled === false ? false : true,
    caps: normalizeCaps(raw && raw.caps),
    notes: String((raw && raw.notes) || "").trim(),
  };
}

export function sortModels(list) {
  return (list || []).slice().sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.order !== b.order) return a.order - b.order;
    return String(a.label).localeCompare(String(b.label), "zh");
  });
}

export function reindexTierOrders(list) {
  const out = (list || []).map((m) => ({ ...m }));
  [1, 2, 3].forEach((tier) => {
    const rows = out
      .filter((m) => m.tier === tier)
      .sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label), "zh"));
    rows.forEach((m, i) => {
      m.order = i;
    });
  });
  return sortModels(out);
}

export async function loadLlmModels(kv, env) {
  if (!kv) return { models: defaultLlmModelsSeed(env), seeded: true };
  const raw = await kv.get(LLM_MODELS_KV_KEY);
  if (!raw) {
    const models = defaultLlmModelsSeed(env);
    await kv.put(LLM_MODELS_KV_KEY, JSON.stringify({ models, updatedAt: Date.now() }));
    return { models, seeded: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;
  }
  let models = sortModels(
    ((parsed && parsed.models) || []).map((m) => normalizeModel(m)).filter((m) => m.modelId)
  );
  // 一次性迁移：老库没有第一梯队时，把原环境变量内置的 Doubao / Qwen 补成可编辑条目。
  // t1m 标记保证只迁移一次——之后用户删光第一梯队也不会被强行补回。
  if (env && !models.some((m) => m.tier === 1) && !(parsed && parsed.t1m)) {
    models = reindexTierOrders([...models, ...tier1DefaultModels(env)]);
    await kv.put(
      LLM_MODELS_KV_KEY,
      JSON.stringify({ models, updatedAt: Date.now(), t1m: true })
    );
    return { models, seeded: false, migrated: true, updatedAt: Date.now() };
  }
  return { models, seeded: false, updatedAt: parsed && parsed.updatedAt };
}

export async function saveLlmModels(kv, models) {
  const normalized = reindexTierOrders(
    (models || []).map((m) => normalizeModel(m)).filter((m) => m.modelId && m.baseUrl)
  );
  const payload = { models: normalized, updatedAt: Date.now(), t1m: true };
  await kv.put(LLM_MODELS_KV_KEY, JSON.stringify(payload));
  return payload;
}

/** 给前端选择器用的精简列表（含 Auto 占位由前端加） */
export function toPickerItems(models) {
  return sortModels(models || [])
    .filter((m) => m.enabled !== false)
    .map((m) => ({
      id: m.id,
      label: m.label,
      modelId: m.modelId,
      tier: m.tier,
      order: m.order,
      caps: m.caps,
    }));
}
