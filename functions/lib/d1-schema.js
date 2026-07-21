/**
 * hzdv D1 全量建表（幂等 CREATE TABLE IF NOT EXISTS）。
 */

import { pickD1ForDebugRegistry } from "./debug-issue-registry-d1.js";
import { ensureHeroBackgroundTables } from "./hero-background-d1.js";

export { pickD1ForDebugRegistry as pickD1Binding };

const USER_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
)`;

const AVATARS_SQL = `
CREATE TABLE IF NOT EXISTS avatars (
  uuid TEXT PRIMARY KEY,
  owner_uuid TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'customs',
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

const AVATARS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_avatars_owner_category
  ON avatars (owner_uuid, category)`;

const DELETE_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS delete_kv_user_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  key_text TEXT NOT NULL,
  uuid TEXT,
  phone TEXT,
  group_text TEXT,
  avatar_delete_enabled_env INTEGER NOT NULL DEFAULT 0,
  avatar_delete_confirmed_request INTEGER NOT NULL DEFAULT 0,
  avatar_delete_executed INTEGER NOT NULL DEFAULT 0,
  r2_keys_found INTEGER NOT NULL DEFAULT 0,
  r2_deleted INTEGER NOT NULL DEFAULT 0,
  d1_deleted_rows INTEGER NOT NULL DEFAULT 0,
  group_index_deleted INTEGER NOT NULL DEFAULT 0,
  cf_connecting_ip TEXT,
  user_agent TEXT,
  note TEXT
)`;

export const D1_TABLE_NAMES = [
  "hero_background_config",
  "hero_background_items",
  "user_settings",
  "avatars",
  "delete_kv_user_audit",
];

export async function ensureAllD1Tables(d1) {
  if (!d1) throw new Error("D1 not configured");
  await ensureHeroBackgroundTables(d1);
  await d1.prepare(USER_SETTINGS_SQL).run();
  await d1.prepare(AVATARS_SQL).run();
  await d1.prepare(AVATARS_INDEX_SQL).run();
  await d1.prepare(DELETE_AUDIT_SQL).run();
}

export async function listExistingD1Tables(d1) {
  const rs = await d1
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    )
    .all();
  return ((rs && rs.results) || []).map((row) => String(row.name));
}

export async function getD1SchemaStatus(d1) {
  const existing = await listExistingD1Tables(d1);
  const expected = D1_TABLE_NAMES.slice();
  const missing = expected.filter((name) => existing.indexOf(name) === -1);
  return {
    table_count: existing.length,
    tables: existing,
    expected_tables: expected,
    missing_tables: missing,
    ready: missing.length === 0,
  };
}
