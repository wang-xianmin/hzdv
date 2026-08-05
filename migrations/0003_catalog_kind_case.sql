-- catalog_items.kind 增加 case（案例）
-- 若 ensureCatalogTables 已自动迁移可跳过；D1 Console 也可手动执行。
-- 注意：SQLite 无法 ALTER CHECK，需重建表。

CREATE TABLE IF NOT EXISTS catalog_items__kind_mig (
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

INSERT INTO catalog_items__kind_mig (
  id, kind, name, model, specs, description, cover_r2_key,
  is_active, sort_order, extra_json, created_at, updated_at
)
SELECT
  id,
  CASE WHEN kind IN ('product', 'solution', 'case') THEN kind ELSE 'product' END,
  name, model, specs, description, cover_r2_key,
  is_active, sort_order, extra_json, created_at, updated_at
FROM catalog_items;

DROP TABLE catalog_items;
ALTER TABLE catalog_items__kind_mig RENAME TO catalog_items;

CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_active_sort
  ON catalog_items (kind, is_active, sort_order, name);

CREATE INDEX IF NOT EXISTS idx_catalog_items_model
  ON catalog_items (model);
