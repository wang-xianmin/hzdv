-- 微信扫码绑定/登录的临时交接表（场景码主键，强一致；行寿命 5 分钟，过期行按概率清理）
-- 也可部署后 POST /api/d1-init（需 MAINTENANCE_SECRET）
CREATE TABLE IF NOT EXISTS wx_scan (
  scene TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  wxu TEXT,
  event TEXT,
  created_at INTEGER NOT NULL,
  scanned_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wx_scan_created ON wx_scan (created_at);
