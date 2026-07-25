/**
 * LLM 模型注册表（KV）
 * - tier: 2 | 3（1 梯队为内置路由/前锋，不进此表）
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

export function defaultLlmModelsSeed() {
  const t2 = [
    {
      label: "qwen-max",
      modelId: "qwen-max",
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "qwen3.7-plus",
      modelId: "qwen3.7-plus",
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "glm-5",
      modelId: "glm-5",
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "ALIYUN_MAAS_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "deepseek-v4-flash",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      caps: { text: true, vision: false, video: false, ocr: false },
    },
    {
      label: "DeepSeek-V4-Flash (SiliconFlow)",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKeyEnv: "QWEN_API_KEY",
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
      baseUrl: "https://ws-6uzq275vpl27mgt5.cn-beijing.maas.aliyuncs.com/api/v1",
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

  return [...t2, ...t3];
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

export function normalizeModel(raw) {
  const tier = Number(raw && raw.tier) === 3 ? 3 : 2;
  const order = Math.max(0, Math.floor(Number(raw && raw.order) || 0));
  return {
    id: String((raw && raw.id) || uid()),
    label: String((raw && (raw.label || raw.name || raw.modelId)) || "").trim() || "unnamed",
    modelId: String((raw && (raw.modelId || raw.model)) || "").trim(),
    baseUrl: String((raw && raw.baseUrl) || "").trim().replace(/\/+$/, ""),
    apiKeyEnv: String((raw && raw.apiKeyEnv) || "").trim(),
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
  [2, 3].forEach((tier) => {
    const rows = out
      .filter((m) => m.tier === tier)
      .sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label), "zh"));
    rows.forEach((m, i) => {
      m.order = i;
    });
  });
  return sortModels(out);
}

export async function loadLlmModels(kv) {
  if (!kv) return { models: defaultLlmModelsSeed(), seeded: true };
  const raw = await kv.get(LLM_MODELS_KV_KEY);
  if (!raw) {
    const models = defaultLlmModelsSeed();
    await kv.put(LLM_MODELS_KV_KEY, JSON.stringify({ models, updatedAt: Date.now() }));
    return { models, seeded: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;
  }
  const models = sortModels(
    ((parsed && parsed.models) || []).map((m) => normalizeModel(m)).filter((m) => m.modelId)
  );
  return { models, seeded: false, updatedAt: parsed && parsed.updatedAt };
}

export async function saveLlmModels(kv, models) {
  const normalized = reindexTierOrders(
    (models || []).map((m) => normalizeModel(m)).filter((m) => m.modelId && m.baseUrl)
  );
  const payload = { models: normalized, updatedAt: Date.now() };
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
