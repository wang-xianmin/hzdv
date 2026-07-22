/**
 * 首页 Hero 背景轮换：D1 表结构与读取。
 * 媒体文件存 R2（建议前缀 hero/），元数据与轮换策略存 D1。
 */

import { pickD1ForDebugRegistry } from "./debug-issue-registry-d1.js";
import { pickR2Binding } from "./cloudflare-bindings.js";

export const DEFAULT_HERO_CONFIG = {
  rotate_interval_ms: 30000,
  transition_ms: 800,
  playback_mode: "sequential",
};

const CREATE_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS hero_background_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rotate_interval_ms INTEGER NOT NULL DEFAULT 30000,
  transition_ms INTEGER NOT NULL DEFAULT 800,
  playback_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (playback_mode IN ('sequential', 'random')),
  updated_at INTEGER NOT NULL
)`;

const CREATE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS hero_background_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
  r2_key TEXT NOT NULL,
  r2_key_mobile TEXT,
  poster_r2_key TEXT,
  poster_r2_key_mobile TEXT,
  public_url TEXT,
  public_url_mobile TEXT,
  poster_public_url TEXT,
  poster_public_url_mobile TEXT,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '',
  cta_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_hero_background_items_active_sort
  ON hero_background_items (is_active, sort_order, id)`;

export function pickHeroD1(env) {
  return pickD1ForDebugRegistry(env);
}

export function normalizeHeroR2Key(rawKey) {
  const key = String(rawKey || "").trim().replace(/^\/+/, "");
  if (!key) return "";
  return key.startsWith("hero/") ? key : `hero/${key}`;
}

function resolvePublicUrl(env, storedUrl, r2Key) {
  const key = normalizeHeroR2Key(r2Key);
  // 有 R2 时一律走同源代理，避免 public_url 残留错误外链导致破图
  if (key && pickR2Binding(env)) {
    return `/api/hero-media?key=${encodeURIComponent(key)}`;
  }
  const direct = String(storedUrl || "").trim();
  if (direct) return direct;
  if (!key) return "";
  const base = String(
    env.HERO_MEDIA_PUBLIC_BASE || env.R2_PUBLIC_BASE || env.MEDIA_PUBLIC_BASE || ""
  )
    .trim()
    .replace(/\/+$/, "");
  if (base) return `${base}/${key}`;
  return "";
}

export async function ensureHeroBackgroundTables(d1) {
  if (!d1) throw new Error("D1 not configured");
  await d1.prepare(CREATE_CONFIG_SQL).run();
  await d1.prepare(CREATE_ITEMS_SQL).run();
  await d1.prepare(CREATE_INDEX_SQL).run();
  // 旧表可能缺手机列：幂等补齐
  const alterCols = [
    "ALTER TABLE hero_background_items ADD COLUMN r2_key_mobile TEXT",
    "ALTER TABLE hero_background_items ADD COLUMN poster_r2_key_mobile TEXT",
    "ALTER TABLE hero_background_items ADD COLUMN public_url_mobile TEXT",
    "ALTER TABLE hero_background_items ADD COLUMN poster_public_url_mobile TEXT",
  ];
  for (const sql of alterCols) {
    try {
      await d1.prepare(sql).run();
    } catch (e) {
      // duplicate column name → ignore
    }
  }
  const now = Date.now();
  await d1
    .prepare(
      `INSERT OR IGNORE INTO hero_background_config
        (id, rotate_interval_ms, transition_ms, playback_mode, updated_at)
       VALUES (1, ?, ?, ?, ?)`
    )
    .bind(
      DEFAULT_HERO_CONFIG.rotate_interval_ms,
      DEFAULT_HERO_CONFIG.transition_ms,
      DEFAULT_HERO_CONFIG.playback_mode,
      now
    )
    .run();
}

export async function getHeroBackgroundConfig(d1) {
  const row = await d1
    .prepare(
      `SELECT rotate_interval_ms, transition_ms, playback_mode, updated_at
       FROM hero_background_config WHERE id = 1`
    )
    .first();
  if (!row) return Object.assign({}, DEFAULT_HERO_CONFIG, { updated_at: Date.now() });
  return {
    rotate_interval_ms: Number(row.rotate_interval_ms) || DEFAULT_HERO_CONFIG.rotate_interval_ms,
    transition_ms: Number(row.transition_ms) || DEFAULT_HERO_CONFIG.transition_ms,
    playback_mode:
      row.playback_mode === "random" ? "random" : DEFAULT_HERO_CONFIG.playback_mode,
    updated_at: Number(row.updated_at) || Date.now(),
  };
}

function mapHeroItemRow(row, env) {
  const r2Key = normalizeHeroR2Key(row.r2_key);
  const r2KeyMobile = row.r2_key_mobile ? normalizeHeroR2Key(row.r2_key_mobile) : "";
  const posterR2Key = row.poster_r2_key ? normalizeHeroR2Key(row.poster_r2_key) : "";
  const posterR2KeyMobile = row.poster_r2_key_mobile ? normalizeHeroR2Key(row.poster_r2_key_mobile) : "";
  return {
    id: Number(row.id),
    media_type: row.media_type === "image" ? "image" : "video",
    r2_key: r2Key,
    r2_key_mobile: r2KeyMobile || null,
    poster_r2_key: posterR2Key || null,
    poster_r2_key_mobile: posterR2KeyMobile || null,
    media_url: resolvePublicUrl(env, row.public_url, r2Key),
    media_url_mobile: resolvePublicUrl(env, row.public_url_mobile, r2KeyMobile),
    poster_url: resolvePublicUrl(env, row.poster_public_url, posterR2Key),
    poster_url_mobile: resolvePublicUrl(env, row.poster_public_url_mobile, posterR2KeyMobile),
    title: String(row.title || ""),
    subtitle: String(row.subtitle || ""),
    cta_label: String(row.cta_label || ""),
    cta_url: String(row.cta_url || ""),
    sort_order: Number(row.sort_order) || 0,
    duration_ms:
      row.duration_ms == null || row.duration_ms === ""
        ? null
        : Number(row.duration_ms) || null,
    is_active: Number(row.is_active) === 1,
    created_by: String(row.created_by || ""),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export async function listActiveHeroBackgroundItems(d1, env) {
  const rs = await d1
    .prepare(
      `SELECT
         id, media_type, r2_key, r2_key_mobile, poster_r2_key, poster_r2_key_mobile,
         public_url, public_url_mobile, poster_public_url, poster_public_url_mobile,
         title, subtitle, cta_label, cta_url, sort_order, duration_ms, is_active,
         created_by, created_at, updated_at
       FROM hero_background_items
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    )
    .all();
  const rows = (rs && rs.results) || [];
  return rows.map((row) => mapHeroItemRow(row, env));
}

export async function listAllHeroBackgroundItems(d1, env) {
  const rs = await d1
    .prepare(
      `SELECT
         id, media_type, r2_key, r2_key_mobile, poster_r2_key, poster_r2_key_mobile,
         public_url, public_url_mobile, poster_public_url, poster_public_url_mobile,
         title, subtitle, cta_label, cta_url, sort_order, duration_ms, is_active,
         created_by, created_at, updated_at
       FROM hero_background_items
       ORDER BY sort_order ASC, id ASC`
    )
    .all();
  const rows = (rs && rs.results) || [];
  return rows.map((row) => mapHeroItemRow(row, env));
}

export async function saveHeroBackgroundConfig(d1, config) {
  const now = Date.now();
  const rotate = Number(config.rotate_interval_ms);
  const transition = Number(config.transition_ms);
  const mode = config.playback_mode === "random" ? "random" : "sequential";
  await d1
    .prepare(
      `INSERT INTO hero_background_config (id, rotate_interval_ms, transition_ms, playback_mode, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rotate_interval_ms = excluded.rotate_interval_ms,
         transition_ms = excluded.transition_ms,
         playback_mode = excluded.playback_mode,
         updated_at = excluded.updated_at`
    )
    .bind(
      rotate > 0 ? rotate : DEFAULT_HERO_CONFIG.rotate_interval_ms,
      transition >= 0 ? transition : DEFAULT_HERO_CONFIG.transition_ms,
      mode,
      now
    )
    .run();
  return getHeroBackgroundConfig(d1);
}

export async function getNextHeroSortOrder(d1) {
  const row = await d1
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM hero_background_items")
    .first();
  return (Number(row && row.max_sort) || 0) + 1;
}

export async function insertHeroBackgroundItem(d1, env, data) {
  const now = Date.now();
  const r2Key = normalizeHeroR2Key(data.r2_key);
  if (!r2Key) throw new Error("Missing r2_key");
  const mediaType = data.media_type === "image" ? "image" : "video";
  const posterKey = data.poster_r2_key ? normalizeHeroR2Key(data.poster_r2_key) : null;
  const sortOrder =
    data.sort_order != null && data.sort_order !== ""
      ? Number(data.sort_order)
      : await getNextHeroSortOrder(d1);
  const rs = await d1
    .prepare(
      `INSERT INTO hero_background_items (
         media_type, r2_key, r2_key_mobile, poster_r2_key, poster_r2_key_mobile,
         title, subtitle, cta_label, cta_url,
         sort_order, duration_ms, is_active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      mediaType,
      r2Key,
      data.r2_key_mobile ? normalizeHeroR2Key(data.r2_key_mobile) : null,
      posterKey,
      data.poster_r2_key_mobile ? normalizeHeroR2Key(data.poster_r2_key_mobile) : null,
      String(data.title || ""),
      String(data.subtitle || ""),
      String(data.cta_label || ""),
      String(data.cta_url || ""),
      sortOrder,
      data.duration_ms == null || data.duration_ms === "" ? null : Number(data.duration_ms),
      data.is_active === false ? 0 : 1,
      String(data.created_by || ""),
      now,
      now
    )
    .run();
  const id = Number(rs.meta && rs.meta.last_row_id);
  const row = await d1
    .prepare("SELECT * FROM hero_background_items WHERE id = ?")
    .bind(id)
    .first();
  return mapHeroItemRow(row, env);
}

export async function updateHeroBackgroundItem(d1, env, id, patch) {
  const existing = await d1
    .prepare("SELECT * FROM hero_background_items WHERE id = ?")
    .bind(id)
    .first();
  if (!existing) return null;
  const now = Date.now();
  const next = {
    media_type:
      patch.media_type === "image" || patch.media_type === "video"
        ? patch.media_type
        : existing.media_type,
    r2_key:
      patch.r2_key != null && String(patch.r2_key).trim() !== ""
        ? normalizeHeroR2Key(patch.r2_key)
        : existing.r2_key,
    r2_key_mobile:
      patch.r2_key_mobile === null
        ? null
        : patch.r2_key_mobile != null && String(patch.r2_key_mobile).trim() !== ""
          ? normalizeHeroR2Key(patch.r2_key_mobile)
          : existing.r2_key_mobile,
    poster_r2_key:
      patch.poster_r2_key === null
        ? null
        : patch.poster_r2_key != null && String(patch.poster_r2_key).trim() !== ""
          ? normalizeHeroR2Key(patch.poster_r2_key)
          : existing.poster_r2_key,
    poster_r2_key_mobile:
      patch.poster_r2_key_mobile === null
        ? null
        : patch.poster_r2_key_mobile != null &&
            String(patch.poster_r2_key_mobile).trim() !== ""
          ? normalizeHeroR2Key(patch.poster_r2_key_mobile)
          : existing.poster_r2_key_mobile,
    title: patch.title != null ? String(patch.title) : existing.title,
    subtitle: patch.subtitle != null ? String(patch.subtitle) : existing.subtitle,
    cta_label: patch.cta_label != null ? String(patch.cta_label) : existing.cta_label,
    cta_url: patch.cta_url != null ? String(patch.cta_url) : existing.cta_url,
    sort_order:
      patch.sort_order != null && patch.sort_order !== ""
        ? Number(patch.sort_order)
        : existing.sort_order,
    duration_ms:
      patch.duration_ms === null || patch.duration_ms === ""
        ? null
        : patch.duration_ms != null
          ? Number(patch.duration_ms)
          : existing.duration_ms,
    is_active:
      patch.is_active != null ? (patch.is_active === false || patch.is_active === 0 ? 0 : 1) : existing.is_active,
    updated_at: now,
  };
  await d1
    .prepare(
      `UPDATE hero_background_items SET
         media_type = ?, r2_key = ?, r2_key_mobile = ?, poster_r2_key = ?, poster_r2_key_mobile = ?,
         title = ?, subtitle = ?, cta_label = ?, cta_url = ?,
         sort_order = ?, duration_ms = ?, is_active = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      next.media_type,
      next.r2_key,
      next.r2_key_mobile,
      next.poster_r2_key,
      next.poster_r2_key_mobile,
      next.title,
      next.subtitle,
      next.cta_label,
      next.cta_url,
      next.sort_order,
      next.duration_ms,
      next.is_active,
      next.updated_at,
      id
    )
    .run();
  const row = await d1.prepare("SELECT * FROM hero_background_items WHERE id = ?").bind(id).first();
  return mapHeroItemRow(row, env);
}

export function guessHeroContentType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "application/octet-stream";
}

export function guessHeroMediaType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (/\.(mp4|webm|mov)$/.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif|heic|heif)$/.test(lower)) return "image";
  return "video";
}

/** 收集一条背景在 R2 上的全部 key（原图/缩略图 × 桌面/手机） */
export function collectHeroItemR2Keys(row) {
  if (!row) return [];
  const keys = [
    row.r2_key,
    row.r2_key_mobile,
    row.poster_r2_key,
    row.poster_r2_key_mobile,
  ];
  const out = [];
  const seen = Object.create(null);
  for (const raw of keys) {
    const k = normalizeHeroR2Key(raw);
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

async function deleteR2Keys(r2, keys) {
  if (!r2 || !keys || !keys.length) return;
  await Promise.all(
    keys.map(async (key) => {
      try {
        await r2.delete(key);
      } catch (e) {
        console.warn("hero R2 delete failed:", key, e);
      }
    })
  );
}

/**
 * 硬删除：先删 R2 原图+缩略图（桌面/手机），再删 D1 行
 */
export async function deleteHeroBackgroundItem(d1, id, r2) {
  const row = await d1
    .prepare("SELECT * FROM hero_background_items WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return false;
  await deleteR2Keys(r2, collectHeroItemR2Keys(row));
  const rs = await d1
    .prepare("DELETE FROM hero_background_items WHERE id = ?")
    .bind(id)
    .run();
  return rs && typeof rs.changes === "number" ? rs.changes > 0 : true;
}

/**
 * 上下移动一行：交换位置后按 0..n-1 重写 sort_order
 * @param {"up"|"down"} direction
 */
export async function moveHeroBackgroundItem(d1, env, id, direction) {
  const dir = direction === "up" ? "up" : direction === "down" ? "down" : "";
  if (!dir) throw new Error("Invalid direction");
  const rs = await d1
    .prepare(
      `SELECT id, sort_order FROM hero_background_items
       ORDER BY sort_order ASC, id ASC`
    )
    .all();
  const list = (rs && rs.results) || [];
  const idx = list.findIndex((row) => Number(row.id) === Number(id));
  if (idx < 0) return null;
  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) {
    return listAllHeroBackgroundItems(d1, env);
  }
  const ordered = list.slice();
  const [moved] = ordered.splice(idx, 1);
  ordered.splice(swapIdx, 0, moved);
  const now = Date.now();
  for (let i = 0; i < ordered.length; i++) {
    await d1
      .prepare(
        `UPDATE hero_background_items SET sort_order = ?, updated_at = ? WHERE id = ?`
      )
      .bind(i, now, Number(ordered[i].id))
      .run();
  }
  return listAllHeroBackgroundItems(d1, env);
}

/** 替换槽位前删掉该槽旧的原图/缩略图 */
export async function deleteHeroSlotR2Keys(r2, row, slot) {
  if (!r2 || !row) return;
  const keys =
    slot === "mobile"
      ? [row.r2_key_mobile, row.poster_r2_key_mobile]
      : [row.r2_key, row.poster_r2_key];
  await deleteR2Keys(
    r2,
    keys.map((k) => normalizeHeroR2Key(k)).filter(Boolean)
  );
}

export function buildHeroUploadKey(filename) {
  const base = String(filename || "upload.bin")
    .split(/[/\\]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalizeHeroR2Key(`${Date.now()}-${base || "upload.bin"}`);
}
