-- 产品 / 系统集成方案目录（同一表，kind 区分；便于 SQL 过滤与向量库 metadata）
-- Cloudflare D1 Console 粘贴执行，或 wrangler d1 execute <DB> --remote --file=./migrations/0002_catalog_items.sql

-- kind:
--   product  = 单品（阀门、仪表、模块等）
--   solution = 系统集成方案 / 成套系统
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
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_active_sort
  ON catalog_items (kind, is_active, sort_order, name);

CREATE INDEX IF NOT EXISTS idx_catalog_items_model
  ON catalog_items (model);

-- 一张条目可多图/多视频（R2 只存 key）
CREATE TABLE IF NOT EXISTS catalog_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  r2_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  caption TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_media_item_sort
  ON catalog_media (item_id, sort_order, id);

-- 方案（kind=solution）主展区四屏内容存于 extra_json.solution，示例：
-- {
--   "solution": {
--     "tag": "分类标签",
--     "hero": { "lead": "简介句1", "sublead": "简介句2" },
--     "summary": { "lead": "简述导语", "highlights": ["要点1","要点2"] },
--     "overview": {
--       "features": [], "applications": [], "recommended_for": []
--     },
--     "advantages": [{ "title": "优势标题", "body": "正文" }]
--   }
-- }
-- 规格仍用 specs 列；媒体 sort_order：0=Hero 封面，1=简述配图。
