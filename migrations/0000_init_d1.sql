-- hzdv D1 初始 schema（空库首次执行）
-- Cloudflare 控制台 → D1 → 你的数据库 → Console → 粘贴执行
-- 或：wrangler d1 execute <DB_NAME> --remote --file=./migrations/0000_init_d1.sql

-- 1) 首页 Hero 背景轮换配置（单行）
CREATE TABLE IF NOT EXISTS hero_background_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rotate_interval_ms INTEGER NOT NULL DEFAULT 30000,
  transition_ms INTEGER NOT NULL DEFAULT 800,
  playback_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (playback_mode IN ('sequential', 'random')),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO hero_background_config (
  id, rotate_interval_ms, transition_ms, playback_mode, updated_at
) VALUES (
  1, 30000, 800, 'sequential', CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- 2) 首页 Hero 背景条目（R2 媒体 + 文案；桌面端/移动端双版本）
CREATE TABLE IF NOT EXISTS hero_background_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
  -- 桌面端（必填）
  r2_key TEXT NOT NULL,
  poster_r2_key TEXT,
  public_url TEXT,
  poster_public_url TEXT,
  -- 移动端（可选，为空时前端 fallback 桌面端）
  r2_key_mobile TEXT,
  poster_r2_key_mobile TEXT,
  public_url_mobile TEXT,
  poster_public_url_mobile TEXT,
  -- 文案
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
);

CREATE INDEX IF NOT EXISTS idx_hero_background_items_active_sort
  ON hero_background_items (is_active, sort_order, id);

-- 3) 用户设置（JSON）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- 4) 头像元数据（R2 对象索引，后续头像功能用）
CREATE TABLE IF NOT EXISTS avatars (
  uuid TEXT PRIMARY KEY,
  owner_uuid TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'customs',
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_avatars_owner_category
  ON avatars (owner_uuid, category);

-- 5) 删除用户审计（delete-kv-user 按需写入）
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
);
