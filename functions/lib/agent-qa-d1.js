/**
 * 企业相关 Agent 问答日志 + 人工纠错后的黄金标准答（D1）
 *
 * - agent_enterprise_qa：所有企业相关问答打点（含「左边列出了」短接）
 * - agent_qa_gold：仅人工修订并发布后写入；可回灌 Vectorize（qa:<id>）
 */

import {
  CATALOG_KIND_KEYS,
  resolveEnterpriseCategory,
} from "./catalog-query-intent.js";

const CREATE_QA_SQL = `
CREATE TABLE IF NOT EXISTS agent_enterprise_qa (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  user_phone TEXT NOT NULL DEFAULT '',

  question TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  category_source TEXT NOT NULL DEFAULT 'fallback',
  intent_tier INTEGER,
  intent_catalog INTEGER NOT NULL DEFAULT 1,

  answer_mode TEXT NOT NULL DEFAULT 'prose',
  reply_text TEXT NOT NULL DEFAULT '',
  hits_json TEXT NOT NULL DEFAULT '[]',

  review_status TEXT NOT NULL DEFAULT 'pending',
  review_focus TEXT,
  review_note TEXT,
  corrected_category TEXT,
  corrected_reply TEXT,
  corrected_hit_ids TEXT,

  publish_target TEXT,
  published_gold_id TEXT,
  model_badge TEXT,
  locale TEXT
)`;

const CREATE_QA_IDX_CREATED = `
CREATE INDEX IF NOT EXISTS idx_agent_eqa_created
  ON agent_enterprise_qa (created_at DESC)`;

const CREATE_QA_IDX_STATUS = `
CREATE INDEX IF NOT EXISTS idx_agent_eqa_category_status
  ON agent_enterprise_qa (category, review_status)`;

const CREATE_GOLD_SQL = `
CREATE TABLE IF NOT EXISTS agent_qa_gold (
  id TEXT PRIMARY KEY,
  source_qa_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,

  question_canonical TEXT NOT NULL,
  question_variants TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'other',

  answer_kind TEXT NOT NULL DEFAULT 'prose',
  reply_text TEXT NOT NULL DEFAULT '',
  bind_item_ids TEXT NOT NULL DEFAULT '[]',

  vector_id TEXT,
  published_at INTEGER
)`;

const CREATE_GOLD_IDX = `
CREATE INDEX IF NOT EXISTS idx_agent_qa_gold_active
  ON agent_qa_gold (is_active, category, updated_at DESC)`;

export const QA_VECTOR_ID_PREFIX = "qa:";

function nowMs() {
  return Date.now();
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return "qa" + String(nowMs()) + Math.random().toString(16).slice(2, 10);
}

function parseJsonArray(raw) {
  try {
    const a = JSON.parse(String(raw || "[]"));
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function normalizeCategory(c) {
  const s = String(c || "").trim();
  if (CATALOG_KIND_KEYS.includes(s)) return s;
  if (s === "other") return "other";
  return "other";
}

function normalizeAnswerMode(m) {
  const s = String(m || "").trim();
  if (s === "showcase_pointer" || s === "catalog_miss" || s === "prose" || s === "gold") {
    return s;
  }
  return "prose";
}

function normalizeReviewStatus(s) {
  const v = String(s || "").trim();
  if (["pending", "ok", "bad", "published"].includes(v)) return v;
  return "pending";
}

function normalizeAnswerKind(k) {
  const v = String(k || "").trim();
  if (v === "catalog_bind" || v === "prose" || v === "hybrid") return v;
  return "prose";
}

function compactHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  return list.slice(0, 20).map((it) => ({
    id: String((it && (it.id || it.item_id)) || ""),
    kind: String((it && it.kind) || "product"),
    name: String((it && it.name) || "").slice(0, 120),
    model: String((it && it.model) || "").slice(0, 80),
    score: it && it.score != null ? Number(it.score) : null,
  }));
}

export function qaVectorId(goldId) {
  return QA_VECTOR_ID_PREFIX + String(goldId || "").trim();
}

export async function ensureAgentQaTables(d1) {
  if (!d1) throw new Error("D1 not configured");
  await d1.prepare(CREATE_QA_SQL).run();
  await d1.prepare(CREATE_QA_IDX_CREATED).run();
  await d1.prepare(CREATE_QA_IDX_STATUS).run();
  await d1.prepare(CREATE_GOLD_SQL).run();
  await d1.prepare(CREATE_GOLD_IDX).run();
}

/**
 * 写入企业问答日志（仅调用方保证已是企业相关）
 */
export async function insertEnterpriseQa(d1, row) {
  await ensureAgentQaTables(d1);
  const id = String((row && row.id) || newId());
  const question = String((row && row.question) || "").trim().slice(0, 4000);
  if (!question) throw new Error("缺少 question");

  const hits = compactHits(row && row.hits);
  let category = normalizeCategory(row && row.category);
  let category_source = String((row && row.category_source) || "").trim();
  if (!category_source) {
    const resolved = resolveEnterpriseCategory(question, hits, null);
    category = normalizeCategory(resolved.category);
    category_source = resolved.category_source;
  }

  const created_at = nowMs();
  await d1
    .prepare(
      `INSERT INTO agent_enterprise_qa (
        id, created_at, session_id, user_phone,
        question, category, category_source, intent_tier, intent_catalog,
        answer_mode, reply_text, hits_json,
        review_status, model_badge, locale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      id,
      created_at,
      String((row && row.session_id) || "").slice(0, 80),
      String((row && row.user_phone) || "").slice(0, 32),
      question,
      category,
      category_source.slice(0, 32),
      row && row.intent_tier != null ? Number(row.intent_tier) || null : null,
      row && row.intent_catalog === false ? 0 : 1,
      normalizeAnswerMode(row && row.answer_mode),
      String((row && row.reply_text) || "").slice(0, 8000),
      JSON.stringify(hits),
      String((row && row.model_badge) || "").slice(0, 80),
      String((row && row.locale) || "").slice(0, 16)
    )
    .run();

  return getEnterpriseQa(d1, id);
}

export async function getEnterpriseQa(d1, id) {
  await ensureAgentQaTables(d1);
  const row = await d1
    .prepare(`SELECT * FROM agent_enterprise_qa WHERE id = ?`)
    .bind(String(id || ""))
    .first();
  return row ? mapQaRow(row) : null;
}

function mapQaRow(r) {
  return {
    id: r.id,
    created_at: Number(r.created_at) || 0,
    session_id: r.session_id || "",
    user_phone: r.user_phone || "",
    question: r.question || "",
    category: r.category || "other",
    category_source: r.category_source || "",
    intent_tier: r.intent_tier != null ? Number(r.intent_tier) : null,
    intent_catalog: Number(r.intent_catalog) !== 0,
    answer_mode: r.answer_mode || "prose",
    reply_text: r.reply_text || "",
    hits: parseJsonArray(r.hits_json),
    review_status: r.review_status || "pending",
    review_focus: r.review_focus || null,
    review_note: r.review_note || null,
    corrected_category: r.corrected_category || null,
    corrected_reply: r.corrected_reply || null,
    corrected_hit_ids: parseJsonArray(r.corrected_hit_ids),
    publish_target: r.publish_target || null,
    published_gold_id: r.published_gold_id || null,
    model_badge: r.model_badge || "",
    locale: r.locale || "",
  };
}

function mapGoldRow(r) {
  return {
    id: r.id,
    source_qa_id: r.source_qa_id || null,
    created_at: Number(r.created_at) || 0,
    updated_at: Number(r.updated_at) || 0,
    is_active: Number(r.is_active) !== 0,
    question_canonical: r.question_canonical || "",
    question_variants: parseJsonArray(r.question_variants).map(String),
    category: r.category || "other",
    answer_kind: r.answer_kind || "prose",
    reply_text: r.reply_text || "",
    bind_item_ids: parseJsonArray(r.bind_item_ids).map(String),
    vector_id: r.vector_id || null,
    published_at: r.published_at != null ? Number(r.published_at) : null,
  };
}

export async function listEnterpriseQa(d1, opts) {
  await ensureAgentQaTables(d1);
  const limit = Math.min(100, Math.max(1, Number(opts && opts.limit) || 50));
  const status = opts && opts.review_status ? normalizeReviewStatus(opts.review_status) : "";
  const category = opts && opts.category ? normalizeCategory(opts.category) : "";

  let sql = `SELECT * FROM agent_enterprise_qa WHERE 1=1`;
  const binds = [];
  if (status) {
    sql += ` AND review_status = ?`;
    binds.push(status);
  }
  if (category && category !== "other") {
    sql += ` AND category = ?`;
    binds.push(category);
  } else if (opts && opts.category === "other") {
    sql += ` AND category = 'other'`;
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);

  const stmt = d1.prepare(sql);
  const rs = await stmt.bind(...binds).all();
  return ((rs && rs.results) || []).map(mapQaRow);
}

/**
 * 人工修订字段（不自动发布）
 */
export async function updateEnterpriseQaReview(d1, id, patch) {
  await ensureAgentQaTables(d1);
  const cur = await getEnterpriseQa(d1, id);
  if (!cur) throw new Error("记录不存在");

  const review_status = patch.review_status
    ? normalizeReviewStatus(patch.review_status)
    : cur.review_status;
  const review_focus =
    patch.review_focus != null
      ? String(patch.review_focus || "").slice(0, 32) || null
      : cur.review_focus;
  const review_note =
    patch.review_note != null
      ? String(patch.review_note || "").slice(0, 4000) || null
      : cur.review_note;
  const corrected_category =
    patch.corrected_category != null
      ? normalizeCategory(patch.corrected_category)
      : cur.corrected_category;
  const corrected_reply =
    patch.corrected_reply != null
      ? String(patch.corrected_reply || "").slice(0, 8000)
      : cur.corrected_reply;
  let corrected_hit_ids = cur.corrected_hit_ids;
  if (patch.corrected_hit_ids != null) {
    corrected_hit_ids = (Array.isArray(patch.corrected_hit_ids)
      ? patch.corrected_hit_ids
      : parseJsonArray(patch.corrected_hit_ids)
    )
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 30);
  }

  await d1
    .prepare(
      `UPDATE agent_enterprise_qa SET
        review_status = ?,
        review_focus = ?,
        review_note = ?,
        corrected_category = ?,
        corrected_reply = ?,
        corrected_hit_ids = ?
       WHERE id = ?`
    )
    .bind(
      review_status === "published" ? cur.review_status : review_status,
      review_focus,
      review_note,
      corrected_category,
      corrected_reply,
      JSON.stringify(corrected_hit_ids || []),
      String(id)
    )
    .run();

  return getEnterpriseQa(d1, id);
}

export async function getQaGold(d1, id) {
  await ensureAgentQaTables(d1);
  const row = await d1
    .prepare(`SELECT * FROM agent_qa_gold WHERE id = ?`)
    .bind(String(id || ""))
    .first();
  return row ? mapGoldRow(row) : null;
}

export async function listQaGold(d1, opts) {
  await ensureAgentQaTables(d1);
  const limit = Math.min(100, Math.max(1, Number(opts && opts.limit) || 50));
  const onlyActive = !(opts && opts.includeInactive);
  let sql = `SELECT * FROM agent_qa_gold`;
  if (onlyActive) sql += ` WHERE is_active = 1`;
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  const rs = await d1.prepare(sql).bind(limit).all();
  return ((rs && rs.results) || []).map(mapGoldRow);
}

/**
 * 从一条已人工修订的日志发布为黄金答（不负责写向量，由调用方回灌）
 */
export async function publishQaFromReview(d1, qaId, opts) {
  await ensureAgentQaTables(d1);
  const qa = await getEnterpriseQa(d1, qaId);
  if (!qa) throw new Error("记录不存在");
  const hasCorrection =
    (qa.corrected_reply && String(qa.corrected_reply).trim()) ||
    (qa.corrected_hit_ids && qa.corrected_hit_ids.length) ||
    (qa.corrected_category &&
      String(qa.corrected_category) !== String(qa.category));
  if (!hasCorrection) {
    throw new Error("未检测到人工纠正内容，无需回灌");
  }

  const answer_kind = normalizeAnswerKind(
    (opts && opts.answer_kind) ||
      (qa.corrected_hit_ids && qa.corrected_hit_ids.length
        ? qa.corrected_reply
          ? "hybrid"
          : "catalog_bind"
        : "prose")
  );
  const question_canonical = String(
    (opts && opts.question_canonical) || qa.question
  )
    .trim()
    .slice(0, 2000);
  const variants = Array.isArray(opts && opts.question_variants)
    ? opts.question_variants.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const category = normalizeCategory(
    qa.corrected_category || qa.category || "other"
  );
  const reply_text = String(
    qa.corrected_reply != null && String(qa.corrected_reply).trim()
      ? qa.corrected_reply
      : answer_kind === "catalog_bind"
        ? ""
        : qa.reply_text || ""
  ).slice(0, 8000);
  const bind_item_ids =
    qa.corrected_hit_ids && qa.corrected_hit_ids.length
      ? qa.corrected_hit_ids
      : [];

  const t = nowMs();
  let goldId = qa.published_gold_id || "";
  if (goldId) {
    const existing = await getQaGold(d1, goldId);
    if (!existing) goldId = "";
  }
  if (!goldId) goldId = newId();
  const vector_id = qaVectorId(goldId);

  await d1
    .prepare(
      `INSERT INTO agent_qa_gold (
        id, source_qa_id, created_at, updated_at, is_active,
        question_canonical, question_variants, category,
        answer_kind, reply_text, bind_item_ids, vector_id, published_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_qa_id = excluded.source_qa_id,
        updated_at = excluded.updated_at,
        is_active = 1,
        question_canonical = excluded.question_canonical,
        question_variants = excluded.question_variants,
        category = excluded.category,
        answer_kind = excluded.answer_kind,
        reply_text = excluded.reply_text,
        bind_item_ids = excluded.bind_item_ids,
        vector_id = excluded.vector_id,
        published_at = excluded.published_at`
    )
    .bind(
      goldId,
      qa.id,
      t,
      t,
      question_canonical,
      JSON.stringify(variants),
      category,
      answer_kind,
      reply_text,
      JSON.stringify(bind_item_ids),
      vector_id,
      t
    )
    .run();

  await d1
    .prepare(
      `UPDATE agent_enterprise_qa SET
        review_status = 'published',
        publish_target = ?,
        published_gold_id = ?
       WHERE id = ?`
    )
    .bind(answer_kind, goldId, qa.id)
    .run();

  return getQaGold(d1, goldId);
}

export async function unpublishQaGold(d1, goldId) {
  await ensureAgentQaTables(d1);
  const gold = await getQaGold(d1, goldId);
  if (!gold) throw new Error("标准答不存在");
  const t = nowMs();
  await d1
    .prepare(
      `UPDATE agent_qa_gold SET is_active = 0, updated_at = ? WHERE id = ?`
    )
    .bind(t, String(goldId))
    .run();
  return getQaGold(d1, goldId);
}

/** 嵌入文本：规范问 + 变体 */
export function goldEmbeddingTexts(gold) {
  const texts = [];
  const main = String((gold && gold.question_canonical) || "").trim();
  if (main) texts.push(main);
  const variants = (gold && gold.question_variants) || [];
  for (const v of variants) {
    const t = String(v || "").trim();
    if (t && texts.indexOf(t) < 0) texts.push(t);
  }
  return texts.length ? texts : main ? [main] : [];
}
