/**
 * 微信扫码绑定/登录的 D1 临时交接表（场景码主键，强一致）。
 */

import { pickD1Binding } from "./cloudflare-bindings.js";

export const WX_SCAN_TTL_MS = 300000;

const CREATE_WX_SCAN_SQL = `
CREATE TABLE IF NOT EXISTS wx_scan (
  scene TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  wxu TEXT,
  event TEXT,
  created_at INTEGER NOT NULL,
  scanned_at INTEGER
)`;

const CREATE_WX_SCAN_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_wx_scan_created ON wx_scan (created_at)`;

let wxScanInitPromise = null;

export function pickWxScanD1(env) {
  return pickD1Binding(env);
}

export async function ensureWxScanTable(d1) {
  if (!wxScanInitPromise) {
    wxScanInitPromise = (async () => {
      await d1.prepare(CREATE_WX_SCAN_SQL).run();
      await d1.prepare(CREATE_WX_SCAN_INDEX_SQL).run();
    })();
  }
  try {
    await wxScanInitPromise;
  } catch (err) {
    wxScanInitPromise = null;
    throw err;
  }
}

export async function createWxScan(d1, { scene, phone, now }) {
  await ensureWxScanTable(d1);
  await d1.prepare(`
    INSERT OR REPLACE INTO wx_scan (scene, phone, wxu, event, created_at, scanned_at)
    VALUES (?1, ?2, NULL, NULL, ?3, NULL)
  `).bind(scene, phone, now).run();

  if (Math.random() < 0.1) {
    try {
      await d1.prepare(`DELETE FROM wx_scan WHERE created_at < ?1`)
        .bind(now - 600000).run();
    } catch (err) {
      console.warn("wx_scan cleanup failed:", err);
    }
  }
}

export async function markWxScanned(d1, { scene, wxu, event, now }) {
  await ensureWxScanTable(d1);
  const result = await d1.prepare(`
    UPDATE wx_scan SET wxu = ?1, event = ?2, scanned_at = ?3
    WHERE scene = ?4 AND created_at >= ?5
  `).bind(wxu, event || null, now, scene, now - WX_SCAN_TTL_MS).run();
  return result.meta?.changes || 0;
}

export async function getWxScan(d1, scene, now) {
  await ensureWxScanTable(d1);
  const row = await d1.prepare(`
    SELECT scene, phone, wxu, event, created_at, scanned_at
    FROM wx_scan WHERE scene = ?1
  `).bind(scene).first();
  if (!row) return null;
  if (row.created_at < now - WX_SCAN_TTL_MS) {
    return { ...row, expired: true };
  }
  return row;
}

export async function deleteWxScan(d1, scene) {
  try {
    await ensureWxScanTable(d1);
    await d1.prepare(`DELETE FROM wx_scan WHERE scene = ?1`)
      .bind(scene).run();
  } catch (err) {
    console.warn("deleteWxScan failed:", err);
  }
}
