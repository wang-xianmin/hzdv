-- 产品 / 系统集成方案目录（同一表，kind 区分；便于 SQL 过滤与向量库 metadata）
-- Cloudflare D1 Console 粘贴执行，或 wrangler d1 execute <DB> --remote --file=./migrations/0002_catalog_items.sql

-- kind:
--   product  = 单品（阀门、仪表、模块等）
--   solution = 系统集成方案 / 成套系统
--   case     = 案例（见 0003_catalog_kind_case.sql）
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
-- 产品（kind=product / case）详情字段约定：
--   description 列 = 特征区：可先写一段正文，末尾再跟键值行，例如：
--     这是一段产品说明……
--
--     输出：
--     21-150 ppm
--     平台：
--     SuperTrak™ 输送
--   系统会自动拆成「正文段落 + 双列键值网格」。
--   extra_json（管理页「扩展JSON」）也可写：
-- {
--   "product": {
--     "highlight": "输出水平最高可达 150 PPM",
--     "attrs": { "输出": "21-150 ppm", "平台": "SuperTrak™ 输送" },
--     "applications": ["制药", "医疗器械"]
--   }
-- }
-- 无 attrs 时，也可把「键:值」分行写在 specs 列作兜底。
-- 规格仍用 specs 列；媒体 sort_order：0=缩略图，1=详情主图，2=方案简述图/视频。
