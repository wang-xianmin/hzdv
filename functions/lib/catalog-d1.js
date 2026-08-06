/**
 * 产品 / 系统集成方案目录（D1）。
 * 媒体在 R2（前缀 catalog/），本表只存元数据与 r2_key。
 */

export const CATALOG_KIND = {
  PRODUCT: "product",
  SOLUTION: "solution",
  CASE: "case",
};

const CREATE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'product'
    CHECK (kind IN ('product', 'solution', 'case')),
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

/** 旧表 CHECK 无 case 时重建（保留数据） */
async function migrateCatalogKindAllowCase(d1) {
  const meta = await d1
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'catalog_items'`
    )
    .first();
  const sql = meta && meta.sql ? String(meta.sql) : "";
  if (!sql) return;
  if (sql.includes("'case'") || sql.includes('"case"')) return;
  if (!/CHECK\s*\(\s*kind\s+IN/i.test(sql)) return;

  await d1.batch([
    d1.prepare(`
      CREATE TABLE catalog_items__kind_mig (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'product'
          CHECK (kind IN ('product', 'solution', 'case')),
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
      )`),
    d1.prepare(`
      INSERT INTO catalog_items__kind_mig (
        id, kind, name, model, specs, description, cover_r2_key,
        is_active, sort_order, extra_json, created_at, updated_at
      )
      SELECT
        id,
        CASE WHEN kind IN ('product', 'solution', 'case') THEN kind ELSE 'product' END,
        name, model, specs, description, cover_r2_key,
        is_active, sort_order, extra_json, created_at, updated_at
      FROM catalog_items`),
    d1.prepare(`DROP TABLE catalog_items`),
    d1.prepare(`ALTER TABLE catalog_items__kind_mig RENAME TO catalog_items`),
  ]);
}

export async function ensureCatalogTables(d1) {
  if (!d1) throw new Error("D1 not configured");
  await d1.prepare(CREATE_ITEMS_SQL).run();
  try {
    await migrateCatalogKindAllowCase(d1);
  } catch (e) {
    // 迁移失败不阻断；新建库已含 case
  }
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
  const k = String(raw || "").trim().toLowerCase();
  if (k === "solution") return "solution";
  if (k === "case") return "case";
  return "product";
}

export const EMPTY_SOLUTION_CONTENT = {
  tag: "",
  hero: { lead: "", sublead: "" },
  summary: { lead: "", highlights: [] },
  overview: {
    features: [],
    applications: [],
    recommended_for: [],
  },
  advantages: [],
};

export function parseExtraJson(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const o = JSON.parse(String(raw || "{}"));
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    return {};
  }
}

function normalizeStringList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeAdvantages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      if (typeof x === "string") {
        const t = x.trim();
        return t ? { title: t, body: "" } : null;
      }
      if (!x || typeof x !== "object") return null;
      const title = String(x.title || "").trim();
      const body = String(x.body || "").trim();
      return title || body ? { title, body } : null;
    })
    .filter(Boolean);
}

/** 方案主展区四屏结构化内容（存于 extra_json.solution） */
export function normalizeSolutionContent(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const hero = s.hero && typeof s.hero === "object" ? s.hero : {};
  const summary = s.summary && typeof s.summary === "object" ? s.summary : {};
  const overview = s.overview && typeof s.overview === "object" ? s.overview : {};
  return {
    tag: String(s.tag || "").trim(),
    hero: {
      lead: String(hero.lead || "").trim(),
      sublead: String(hero.sublead || "").trim(),
    },
    summary: {
      lead: String(summary.lead || "").trim(),
      highlights: normalizeStringList(summary.highlights),
    },
    overview: {
      features: normalizeStringList(overview.features),
      applications: normalizeStringList(overview.applications),
      recommended_for: normalizeStringList(overview.recommended_for),
    },
    advantages: normalizeAdvantages(s.advantages),
  };
}

export function getItemSolution(item) {
  if (!item || normalizeKind(item.kind) !== "solution") {
    return normalizeSolutionContent(null);
  }
  const extra = parseExtraJson(item.extra_json);
  return normalizeSolutionContent(extra.solution);
}

/**
 * 产品/案例详情：特点与适用场景
 * 优先 extra_json.product；否则用 description 按行拆成特点。
 */
export function getItemProductContent(item) {
  const empty = { features: [], applications: [] };
  if (!item) return empty;
  const kind = normalizeKind(item.kind);
  if (kind === "solution") return empty;
  const extra = parseExtraJson(item.extra_json);
  const p =
    (extra.product && typeof extra.product === "object" && extra.product) ||
    (extra.case && typeof extra.case === "object" && extra.case) ||
    {};
  let features = normalizeStringList(p.features);
  let applications = normalizeStringList(
    p.applications || p.scenarios || p.use_cases
  );
  if (!features.length) {
    features = String(item.description || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { features, applications };
}

export function mergeExtraJsonSolution(extraJson, solution) {
  const extra = parseExtraJson(extraJson);
  extra.solution = normalizeSolutionContent(solution);
  return JSON.stringify(extra);
}

function rowToItem(row) {
  if (!row) return null;
  const kind = normalizeKind(row.kind);
  const extraJson = String(row.extra_json || "{}");
  const item = {
    id: String(row.id),
    kind,
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
    extra_json: extraJson,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
  if (kind === "solution") {
    item.solution = getItemSolution(item);
  } else {
    item.product = getItemProductContent(item);
  }
  return item;
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

function applyFirstMediaCover(item) {
  if (!item) return item;
  const media = item.media || [];
  const firstImg = media.find((m) => m.media_type === "image") || media[0];
  if (firstImg) {
    item.cover_r2_key = firstImg.r2_key;
    item.cover_url = firstImg.url;
  } else {
    item.cover_r2_key = "";
    item.cover_url = "";
  }
  return item;
}

/** 约定：媒体按 sort_order 排序后，第 1 张图 = 封面/缩略图；第 2 张 = 详情主图 */
async function syncCoverToFirstMedia(d1, itemId) {
  const media = await listCatalogMedia(d1, itemId);
  const firstImg = media.find((m) => m.media_type === "image") || media[0];
  const key = firstImg ? firstImg.r2_key : null;
  await d1
    .prepare(
      `UPDATE catalog_items SET cover_r2_key = ?, updated_at = ? WHERE id = ?`
    )
    .bind(key, nowMs(), String(itemId))
    .run();
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
    applyFirstMediaCover(item);
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
  applyFirstMediaCover(item);
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
  let extraJson = "{}";
  if (fields && fields.extra_json != null) {
    extraJson =
      typeof fields.extra_json === "string"
        ? fields.extra_json
        : JSON.stringify(fields.extra_json);
  }
  if (fields && fields.solution != null) {
    extraJson = mergeExtraJsonSolution(extraJson, fields.solution);
  }
  await d1
    .prepare(
      `INSERT INTO catalog_items (
        id, kind, name, model, specs, description, cover_r2_key,
        is_active, sort_order, extra_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      kind,
      name,
      model,
      specs,
      description,
      isActive,
      sortOrder,
      extraJson,
      t,
      t
    )
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
    fields && Object.prototype.hasOwnProperty.call(fields, "model")
      ? String(fields.model == null ? "" : fields.model).trim()
      : cur.model;
  const specs =
    fields && Object.prototype.hasOwnProperty.call(fields, "specs")
      ? String(fields.specs == null ? "" : fields.specs)
      : cur.specs;
  const description =
    fields && Object.prototype.hasOwnProperty.call(fields, "description")
      ? String(fields.description == null ? "" : fields.description)
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
  let extraJson = cur.extra_json || "{}";
  if (fields && fields.extra_json != null) {
    extraJson =
      typeof fields.extra_json === "string"
        ? fields.extra_json
        : JSON.stringify(fields.extra_json);
  }
  if (fields && fields.solution != null) {
    extraJson = mergeExtraJsonSolution(extraJson, fields.solution);
  }
  const t = nowMs();
  await d1
    .prepare(
      `UPDATE catalog_items SET
        kind = ?, name = ?, model = ?, specs = ?, description = ?,
        cover_r2_key = ?, is_active = ?, sort_order = ?, extra_json = ?, updated_at = ?
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
      extraJson,
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
  await syncCoverToFirstMedia(d1, itemId);
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
  await syncCoverToFirstMedia(d1, itemId);
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

function truncateEmbed(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n);
}

/** 拼进向量库的文本：名称 + 型号 + 规格 + 方案结构化块 + 说明 + 同义词
 * @param {object} [synonymMap] getCatalogSynonymMap 结果；重建索引时传入
 */
export function catalogItemEmbeddingText(row, synonymMap) {
  if (!row || typeof row !== "object") return "";
  const kindLabel =
    row.kind === "solution"
      ? "系统集成方案"
      : row.kind === "case"
        ? "案例"
        : "产品";
  const synKey =
    row.kind === "solution"
      ? "solution"
      : row.kind === "case"
        ? "case"
        : "product";
  const syn =
    synonymMap && Array.isArray(synonymMap[synKey])
      ? synonymMap[synKey].join(" ")
      : row.kind === "solution"
        ? "系统集成 成套 产线 装配线"
        : row.kind === "case"
          ? "例子 实例 应用案例 项目案例"
          : "单品 设备 模块";
  const parts = [
    kindLabel,
    syn,
    row.name,
    row.model ? "型号 " + row.model : "",
  ];
  if (row.kind === "solution") {
    const sol = row.solution || getItemSolution(row);
    if (sol.tag) parts.push(sol.tag);
    if (sol.hero.lead) parts.push(sol.hero.lead);
    if (sol.hero.sublead) parts.push(sol.hero.sublead);
    if (sol.summary.lead) parts.push(sol.summary.lead);
    parts.push(...sol.summary.highlights);
    parts.push(...sol.overview.features);
    parts.push(...sol.overview.applications);
    parts.push(...sol.overview.recommended_for);
    for (const adv of sol.advantages) {
      parts.push(adv.title);
      if (adv.body) parts.push(truncateEmbed(adv.body, 80));
    }
  }
  parts.push(row.specs);
  parts.push(row.description);
  return parts
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("\n");
}

/** 对外 API：主展区用精简视图 */
export function catalogItemPublicView(item) {
  if (!item) return null;
  const media = (item.media || []).map((m) => ({
    id: m.id,
    media_type: m.media_type,
    url: m.url,
    sort_order: m.sort_order,
    caption: m.caption,
  }));
  const images = media.filter((m) => m.media_type === "image");
  // 约定：第 1 张图 = 封面/缩略图；第 2 张 = 产品详情主图（方案简述配图）
  const heroImage = (images[0] && images[0].url) || item.cover_url || "";
  const summaryImage =
    (images[1] && images[1].url) || heroImage || "";
  const solution =
    item.kind === "solution"
      ? item.solution || getItemSolution(item)
      : null;
  const product =
    item.kind !== "solution"
      ? item.product || getItemProductContent(item)
      : null;
  const blurb =
    (solution &&
      (solution.hero.lead ||
        solution.summary.lead ||
        solution.hero.sublead)) ||
    String(item.description || "").trim().slice(0, 120);
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    model: item.model,
    specs: item.specs,
    description: String(item.description || "").trim(),
    cover_url: item.cover_url || heroImage,
    hero_image: heroImage,
    summary_image: summaryImage,
    media,
    solution,
    product,
    features: (product && product.features) || [],
    applications: (product && product.applications) || [],
    blurb,
  };
}
