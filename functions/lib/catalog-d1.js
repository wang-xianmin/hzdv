/**
 * 产品 / 系统集成方案目录（D1）。
 * 媒体在 R2（前缀 catalog/），本表只存元数据与 r2_key。
 */

export const CATALOG_KIND = {
  PRODUCT: "product",
  SOLUTION: "solution",
};

const CREATE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'product'
    CHECK (kind IN ('product', 'solution')),
  name TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  specs TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_r2_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_ITEMS_KIND_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_active_sort
  ON catalog_items (kind, is_active, sort_order, name)`;

const CREATE_ITEMS_MODEL_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_catalog_items_model
  ON catalog_items (model)`;

const CREATE_MEDIA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  r2_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  caption TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`;

const CREATE_MEDIA_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_catalog_media_item_sort
  ON catalog_media (item_id, sort_order, id)`;

export async function ensureCatalogTables(d1) {
  if (!d1) throw new Error("D1 not configured");
  await d1.prepare(CREATE_ITEMS_SQL).run();
  await d1.prepare(CREATE_ITEMS_KIND_INDEX_SQL).run();
  await d1.prepare(CREATE_ITEMS_MODEL_INDEX_SQL).run();
  await d1.prepare(CREATE_MEDIA_SQL).run();
  await d1.prepare(CREATE_MEDIA_INDEX_SQL).run();
}

export function normalizeCatalogR2Key(rawKey) {
  const key = String(rawKey || "")
    .trim()
    .replace(/^\/+/, "");
  if (!key) return "";
  if (key.includes("..") || key.includes("\\")) return "";
  return key.startsWith("catalog/") ? key : "catalog/" + key;
}

export function catalogMediaPublicUrl(r2Key) {
  const key = normalizeCatalogR2Key(r2Key);
  if (!key) return "";
  return "/api/catalog-media?key=" + encodeURIComponent(key);
}

export function guessCatalogMediaType(filenameOrType) {
  const s = String(filenameOrType || "").toLowerCase();
  if (s.startsWith("video/") || /\.(mp4|webm|mov|m4v)(\?|$)/.test(s)) {
    return "video";
  }
  return "image";
}

export function guessCatalogContentType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

export function buildCatalogUploadKey(filename) {
  const safe = String(filename || "upload.bin")
    .replace(/[^\w.\-()+]+/g, "_")
    .slice(0, 80);
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : String(Date.now());
  return normalizeCatalogR2Key(id + "_" + safe);
}

function newItemId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function nowMs() {
  return Date.now();
}

function normalizeKind(raw) {
  return String(raw || "").trim() === "solution" ? "solution" : "product";
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    kind: normalizeKind(row.kind),
    name: String(row.name || ""),
    model: String(row.model || ""),
    specs: String(row.specs || ""),
    description: String(row.description || ""),
    cover_r2_key: row.cover_r2_key ? String(row.cover_r2_key) : "",
    cover_url: row.cover_r2_key
      ? catalogMediaPublicUrl(row.cover_r2_key)
      : "",
    is_active: Number(row.is_active) !== 0 ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
    extra_json: String(row.extra_json || "{}"),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

function rowToMedia(row) {
  if (!row) return null;
  const key = String(row.r2_key || "");
  return {
    id: Number(row.id),
    item_id: String(row.item_id),
    media_type: row.media_type === "video" ? "video" : "image",
    r2_key: key,
    url: catalogMediaPublicUrl(key),
    sort_order: Number(row.sort_order) || 0,
    caption: String(row.caption || ""),
    created_at: Number(row.created_at) || 0,
  };
}

export async function listCatalogMedia(d1, itemId) {
  const rs = await d1
    .prepare(
      `SELECT id, item_id, media_type, r2_key, sort_order, caption, created_at
       FROM catalog_media
       WHERE item_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .bind(String(itemId))
    .all();
  return ((rs && rs.results) || []).map(rowToMedia).filter(Boolean);
}

export async function listCatalogItems(d1, opts) {
  const includeInactive = !!(opts && opts.includeInactive);
  const sql = includeInactive
    ? `SELECT * FROM catalog_items ORDER BY sort_order ASC, name ASC, id ASC`
    : `SELECT * FROM catalog_items WHERE is_active = 1 ORDER BY sort_order ASC, name ASC, id ASC`;
  const rs = await d1.prepare(sql).all();
  const items = ((rs && rs.results) || []).map(rowToItem).filter(Boolean);
  for (const item of items) {
    item.media = await listCatalogMedia(d1, item.id);
    if (!item.cover_r2_key && item.media.length) {
      const cover =
        item.media.find((m) => m.media_type === "image") || item.media[0];
      if (cover) {
        item.cover_r2_key = cover.r2_key;
        item.cover_url = cover.url;
      }
    }
    item.media_counts = {
      image: item.media.filter((m) => m.media_type === "image").length,
      video: item.media.filter((m) => m.media_type === "video").length,
    };
  }
  return items;
}

export async function getCatalogItem(d1, id) {
  const row = await d1
    .prepare(`SELECT * FROM catalog_items WHERE id = ?`)
    .bind(String(id))
    .first();
  const item = rowToItem(row);
  if (!item) return null;
  item.media = await listCatalogMedia(d1, item.id);
  item.media_counts = {
    image: item.media.filter((m) => m.media_type === "image").length,
    video: item.media.filter((m) => m.media_type === "video").length,
  };
  return item;
}

export async function createCatalogItem(d1, fields) {
  const id = newItemId();
  const t = nowMs();
  const kind = normalizeKind(fields && fields.kind);
  const name = String((fields && fields.name) || "").trim() || "未命名";
  const model = String((fields && fields.model) || "").trim();
  const specs = String((fields && fields.specs) || "").trim();
  const description = String((fields && fields.description) || "").trim();
  const isActive =
    fields && fields.is_active != null
      ? Number(fields.is_active) !== 0
        ? 1
        : 0
      : 1;
  const sortOrder = Math.max(0, Math.floor(Number(fields && fields.sort_order) || 0));
  await d1
    .prepare(
      `INSERT INTO catalog_items (
        id, kind, name, model, specs, description, cover_r2_key,
        is_active, sort_order, extra_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, '{}', ?, ?)`
    )
    .bind(id, kind, name, model, specs, description, isActive, sortOrder, t, t)
    .run();
  return getCatalogItem(d1, id);
}

export async function updateCatalogItem(d1, id, fields) {
  const cur = await getCatalogItem(d1, id);
  if (!cur) return null;
  const kind =
    fields && fields.kind != null ? normalizeKind(fields.kind) : cur.kind;
  const name =
    fields && fields.name != null
      ? String(fields.name).trim() || cur.name
      : cur.name;
  const model =
    fields && fields.model != null ? String(fields.model).trim() : cur.model;
  const specs =
    fields && fields.specs != null ? String(fields.specs) : cur.specs;
  const description =
    fields && fields.description != null
      ? String(fields.description)
      : cur.description;
  const isActive =
    fields && fields.is_active != null
      ? Number(fields.is_active) !== 0
        ? 1
        : 0
      : cur.is_active;
  const sortOrder =
    fields && fields.sort_order != null
      ? Math.max(0, Math.floor(Number(fields.sort_order) || 0))
      : cur.sort_order;
  let cover = cur.cover_r2_key || null;
  if (fields && Object.prototype.hasOwnProperty.call(fields, "cover_r2_key")) {
    cover = normalizeCatalogR2Key(fields.cover_r2_key) || null;
  }
  const t = nowMs();
  await d1
    .prepare(
      `UPDATE catalog_items SET
        kind = ?, name = ?, model = ?, specs = ?, description = ?,
        cover_r2_key = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      kind,
      name,
      model,
      specs,
      description,
      cover,
      isActive,
      sortOrder,
      t,
      String(id)
    )
    .run();
  return getCatalogItem(d1, id);
}

export async function deleteCatalogItem(d1, r2, id) {
  const item = await getCatalogItem(d1, id);
  if (!item) return { ok: false, missing: true };
  const keys = [];
  if (item.cover_r2_key) keys.push(normalizeCatalogR2Key(item.cover_r2_key));
  for (const m of item.media || []) {
    const k = normalizeCatalogR2Key(m.r2_key);
    if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  await d1
    .prepare(`DELETE FROM catalog_media WHERE item_id = ?`)
    .bind(String(id))
    .run();
  await d1
    .prepare(`DELETE FROM catalog_items WHERE id = ?`)
    .bind(String(id))
    .run();
  if (r2) {
    for (const k of keys) {
      try {
        await r2.delete(k);
      } catch (e) {}
    }
  }
  return { ok: true, deleted_keys: keys.length };
}

export async function addCatalogMedia(d1, itemId, meta) {
  const item = await getCatalogItem(d1, itemId);
  if (!item) return null;
  const key = normalizeCatalogR2Key(meta && meta.r2_key);
  if (!key) throw new Error("缺少 r2_key");
  const mediaType =
    (meta && meta.media_type) === "video" ? "video" : "image";
  const caption = String((meta && meta.caption) || "").trim();
  const sortOrder = Math.max(
    0,
    Math.floor(
      Number(meta && meta.sort_order) ||
        (item.media && item.media.length) ||
        0
    )
  );
  const t = nowMs();
  const rs = await d1
    .prepare(
      `INSERT INTO catalog_media (item_id, media_type, r2_key, sort_order, caption, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(String(itemId), mediaType, key, sortOrder, caption, t)
    .run();
  if (!item.cover_r2_key && mediaType === "image") {
    await d1
      .prepare(
        `UPDATE catalog_items SET cover_r2_key = ?, updated_at = ? WHERE id = ?`
      )
      .bind(key, t, String(itemId))
      .run();
  } else {
    await d1
      .prepare(`UPDATE catalog_items SET updated_at = ? WHERE id = ?`)
      .bind(t, String(itemId))
      .run();
  }
  const mediaId =
    rs && rs.meta && rs.meta.last_row_id != null
      ? Number(rs.meta.last_row_id)
      : null;
  const all = await listCatalogMedia(d1, itemId);
  if (mediaId) {
    const hit = all.find((m) => m.id === mediaId);
    if (hit) return hit;
  }
  return all[all.length - 1] || null;
}

export async function deleteCatalogMedia(d1, r2, mediaId) {
  const row = await d1
    .prepare(`SELECT * FROM catalog_media WHERE id = ?`)
    .bind(Number(mediaId))
    .first();
  if (!row) return { ok: false, missing: true };
  const itemId = String(row.item_id);
  const key = normalizeCatalogR2Key(row.r2_key);
  await d1
    .prepare(`DELETE FROM catalog_media WHERE id = ?`)
    .bind(Number(mediaId))
    .run();
  const item = await getCatalogItem(d1, itemId);
  if (item && item.cover_r2_key === key) {
    const nextImg = (item.media || []).find((m) => m.media_type === "image");
    const nextKey = nextImg ? nextImg.r2_key : null;
    await d1
      .prepare(
        `UPDATE catalog_items SET cover_r2_key = ?, updated_at = ? WHERE id = ?`
      )
      .bind(nextKey, nowMs(), itemId)
      .run();
  }
  if (r2 && key) {
    try {
      await r2.delete(key);
    } catch (e) {}
  }
  return { ok: true, item_id: itemId };
}

export async function setCatalogCover(d1, itemId, r2Key) {
  const key = normalizeCatalogR2Key(r2Key);
  if (!key) throw new Error("缺少 cover_r2_key");
  const item = await getCatalogItem(d1, itemId);
  if (!item) return null;
  await d1
    .prepare(
      `UPDATE catalog_items SET cover_r2_key = ?, updated_at = ? WHERE id = ?`
    )
    .bind(key, nowMs(), String(itemId))
    .run();
  return getCatalogItem(d1, itemId);
}

/** 拼进向量库的文本：名称 + 型号 + 规格 + 说明 */
export function catalogItemEmbeddingText(row) {
  if (!row || typeof row !== "object") return "";
  const parts = [
    row.kind === "solution" ? "系统集成方案" : "产品",
    row.name,
    row.model ? "型号 " + row.model : "",
    row.specs,
    row.description,
  ];
  return parts
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("\n");
}
