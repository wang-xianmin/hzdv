-- 首页 Hero 背景图/视频轮换（D1）
-- 建议优先执行全量初始化：migrations/0000_init_d1.sql
-- 或部署后 POST /api/d1-init（需 MAINTENANCE_SECRET）

CREATE TABLE IF NOT EXISTS hero_background_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rotate_interval_ms INTEGER NOT NULL DEFAULT 30000,
  transition_ms INTEGER NOT NULL DEFAULT 800,
  playback_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (playback_mode IN ('sequential', 'random')),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO hero_background_config (id, rotate_interval_ms, transition_ms, playback_mode, updated_at)
VALUES (1, 30000, 800, 'sequential', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS hero_background_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
  r2_key TEXT NOT NULL,
  poster_r2_key TEXT,
  public_url TEXT,
  poster_public_url TEXT,
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

-- 示例（上传 R2 后把 key 改成真实路径再执行）：
-- INSERT INTO hero_background_items (
--   media_type, r2_key, poster_r2_key, title, subtitle, sort_order, created_at, updated_at
-- ) VALUES (
--   'video',
--   'hero/demo-10s.mp4',
--   'hero/demo-10s-poster.jpg',
--   '欢迎',
--   '副标题',
--   0,
--   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
--   CAST(strftime('%s', 'now') AS INTEGER) * 1000
-- );
