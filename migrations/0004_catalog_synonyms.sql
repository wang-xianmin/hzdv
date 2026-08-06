-- 目录同义词（运维可维护）
-- canonical: product | solution | case
-- aliases_json: ["单品","设备",...]

CREATE TABLE IF NOT EXISTS catalog_synonyms (
  canonical TEXT PRIMARY KEY
    CHECK (canonical IN ('product', 'solution', 'case')),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO catalog_synonyms (canonical, aliases_json, updated_at) VALUES
  ('product', '["产品","单品","设备","阀门","仪表","模块","配件","货品"]', 0),
  ('solution', '["方案","系统集成","成套","产线","装配线","集成系统","交钥匙"]', 0),
  ('case', '["案例","例子","实例","应用案例","成功案例","项目案例","样板"]', 0);
