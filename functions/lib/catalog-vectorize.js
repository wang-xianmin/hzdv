/**
 * catalog_items → Workers AI Embedding → Vectorize
 * 约定：index 768 维 cosine；模型 @cf/google/embeddinggemma-300m
 */

import { catalogItemEmbeddingText } from "./catalog-d1.js";

export const CATALOG_EMBED_MODEL = "@cf/google/embeddinggemma-300m";
export const CATALOG_EMBED_DIMS = 768;
export const CATALOG_VECTOR_ID_PREFIX = "catalog:";

export function pickAiBinding(env) {
  if (!env) return null;
  if (env.AI && typeof env.AI.run === "function") return env.AI;
  return null;
}

export function pickVectorizeBinding(env) {
  if (!env) return null;
  const cands = [
    env.VECTORIZE,
    env.HZDV_INDEX,
    env.hzdv_index,
    env.CATALOG_VECTORIZE,
  ];
  for (const v of cands) {
    if (v && typeof v.upsert === "function" && typeof v.query === "function") {
      return v;
    }
  }
  return null;
}

export function catalogVectorId(itemId) {
  return CATALOG_VECTOR_ID_PREFIX + String(itemId || "").trim();
}

function truncateMeta(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n);
}

/** Workers AI embedding → number[] */
export async function embedTexts(ai, texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!list.length) throw new Error("无可嵌入文本");
  if (!ai) throw new Error("AI binding 未配置（Pages 绑定 Workers AI）");

  const out = await ai.run(CATALOG_EMBED_MODEL, { text: list });
  // 常见形状：{ data: number[][] } 或 { data: [{ shape, data }] }
  let rows = null;
  if (out && Array.isArray(out.data)) {
    if (out.data.length && typeof out.data[0] === "number") {
      rows = [out.data];
    } else if (out.data.length && Array.isArray(out.data[0])) {
      rows = out.data;
    } else if (out.data.length && out.data[0] && Array.isArray(out.data[0].data)) {
      rows = out.data.map((r) => r.data);
    }
  }
  if (!rows || !rows.length) {
    throw new Error("Embedding 返回格式无法解析：" + JSON.stringify(out).slice(0, 200));
  }
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== CATALOG_EMBED_DIMS) {
      throw new Error(
        "Embedding 维度应为 " +
          CATALOG_EMBED_DIMS +
          "，实际 " +
          (row && row.length)
      );
    }
  }
  return rows;
}

export function catalogItemToVectorRecord(item, values) {
  const id = catalogVectorId(item.id);
  return {
    id,
    values,
    metadata: {
      source: "catalog",
      kind:
        item.kind === "solution"
          ? "solution"
          : item.kind === "case"
            ? "case"
            : "product",
      item_id: String(item.id),
      name: truncateMeta(item.name, 120),
      model: truncateMeta(item.model, 80),
      is_active: Number(item.is_active) !== 0 ? 1 : 0,
    },
  };
}

/**
 * 将目录条目写入 Vectorize（仅 is_active=1；停用则 delete）
 * @returns {{ upserted: number, deleted: number, skipped: number, errors: string[] }}
 */
export async function indexCatalogItems(env, items) {
  const ai = pickAiBinding(env);
  const index = pickVectorizeBinding(env);
  if (!ai) throw new Error("缺少 AI 绑定");
  if (!index) throw new Error("缺少 Vectorize 绑定（VECTORIZE / HZDV_INDEX）");

  const active = [];
  const toDelete = [];
  for (const item of items || []) {
    if (!item || !item.id) continue;
    if (Number(item.is_active) === 0) {
      toDelete.push(catalogVectorId(item.id));
      continue;
    }
    const text = catalogItemEmbeddingText(item);
    if (!text.trim()) continue;
    active.push({ item, text });
  }

  const errors = [];
  let upserted = 0;
  let skipped = (items || []).length - active.length - toDelete.length;

  // 分批嵌入（Workers AI 一次可多条）
  const BATCH = 8;
  for (let i = 0; i < active.length; i += BATCH) {
    const chunk = active.slice(i, i + BATCH);
    try {
      const vectors = await embedTexts(
        ai,
        chunk.map((c) => c.text)
      );
      const records = chunk.map((c, j) =>
        catalogItemToVectorRecord(c.item, vectors[j])
      );
      await index.upsert(records);
      upserted += records.length;
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }

  let deleted = 0;
  if (toDelete.length) {
    try {
      await index.deleteByIds(toDelete);
      deleted = toDelete.length;
    } catch (e) {
      // 部分 binding 可能无 deleteByIds
      errors.push("delete: " + String((e && e.message) || e));
    }
  }

  return { upserted, deleted, skipped, errors, model: CATALOG_EMBED_MODEL };
}

export async function queryCatalogVectors(env, queryText, opts) {
  const ai = pickAiBinding(env);
  const index = pickVectorizeBinding(env);
  if (!ai) throw new Error("缺少 AI 绑定");
  if (!index) throw new Error("缺少 Vectorize 绑定");
  const q = String(queryText || "").trim();
  if (!q) throw new Error("缺少查询文本");

  const [values] = await embedTexts(ai, [q]);
  const topK = Math.min(20, Math.max(1, Number(opts && opts.topK) || 5));
  const filter =
    opts && opts.kind
      ? { source: "catalog", kind: String(opts.kind) }
      : { source: "catalog" };

  const res = await index.query(values, {
    topK,
    returnMetadata: "all",
    filter,
  });
  const matches = (res && res.matches) || [];
  return {
    model: CATALOG_EMBED_MODEL,
    matches: matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata || {},
    })),
  };
}
