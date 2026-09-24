/**
 * 运维文档库（D1 元数据 + R2 文件）。
 * R2 前缀：ops-docs/
 */

export const OPS_DOCS_R2_PREFIX = "ops-docs/";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ops_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  publisher_phone TEXT NOT NULL,
  publisher_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_IDX_CREATED = `
CREATE INDEX IF NOT EXISTS idx_ops_documents_created
  ON ops_documents (created_at DESC)`;

const CREATE_IDX_PUBLISHER = `
CREATE INDEX IF NOT EXISTS idx_ops_documents_publisher
  ON ops_documents (publisher_phone, created_at DESC)`;

const ALLOWED_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "md",
  "csv",
  "rtf",
  "odt",
  "ods",
  "odp",
]);

const MAX_BYTES = 40 * 1024 * 1024; // 40MB

export function opsDocsMaxBytes() {
  return MAX_BYTES;
}

export async function ensureOpsDocumentsTable(d1) {
  if (!d1) throw new Error("D1 not configured");
  await d1.prepare(CREATE_SQL).run();
  await d1.prepare(CREATE_IDX_CREATED).run();
  await d1.prepare(CREATE_IDX_PUBLISHER).run();
}

function nowMs() {
  return Date.now();
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return "doc" + String(nowMs()) + Math.random().toString(16).slice(2, 10);
}

function sanitizeFileName(name) {
  const base = String(name || "file")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return base || "file";
}

export function fileExt(name) {
  const m = String(name || "")
    .toLowerCase()
    .match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

export function isAllowedOpsDocName(name) {
  const ext = fileExt(name);
  return !!ext && ALLOWED_EXT.has(ext);
}

export function guessOpsDocContentType(name, fallback) {
  const ext = fileExt(name);
  const map = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
  };
  if (map[ext]) return map[ext];
  const fb = String(fallback || "").trim();
  return fb || "application/octet-stream";
}

export function normalizeOpsDocR2Key(raw) {
  let key = String(raw || "").trim().replace(/^\/+/, "");
  if (!key) return "";
  if (!key.startsWith(OPS_DOCS_R2_PREFIX)) {
    key = OPS_DOCS_R2_PREFIX + key.replace(/^ops-docs\/?/i, "");
  }
  if (key.includes("..") || key.includes("\\")) return "";
  return key;
}

export function buildOpsDocUploadKey(id, originalName) {
  const safe = sanitizeFileName(originalName);
  const ext = fileExt(safe);
  const stamp = String(nowMs());
  const leaf = ext ? `${id}_${stamp}.${ext}` : `${id}_${stamp}`;
  return OPS_DOCS_R2_PREFIX + leaf;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    original_name: String(row.original_name || ""),
    content_type: String(row.content_type || ""),
    size_bytes: Number(row.size_bytes) || 0,
    r2_key: String(row.r2_key || ""),
    publisher_phone: String(row.publisher_phone || ""),
    publisher_name: String(row.publisher_name || ""),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export async function listOpsDocuments(d1, opts) {
  await ensureOpsDocumentsTable(d1);
  const limit = Math.min(
    200,
    Math.max(1, Number((opts && opts.limit) || 100) || 100)
  );
  const rs = await d1
    .prepare(
      `SELECT * FROM ops_documents ORDER BY created_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return ((rs && rs.results) || []).map(mapRow);
}

export async function getOpsDocument(d1, id) {
  await ensureOpsDocumentsTable(d1);
  const row = await d1
    .prepare(`SELECT * FROM ops_documents WHERE id = ?`)
    .bind(String(id || "").trim())
    .first();
  return mapRow(row);
}

export async function insertOpsDocument(d1, fields) {
  await ensureOpsDocumentsTable(d1);
  const id = String((fields && fields.id) || newId());
  const title = String((fields && fields.title) || "").trim().slice(0, 200);
  if (!title) throw new Error("缺少 title");
  const r2_key = normalizeOpsDocR2Key(fields && fields.r2_key);
  if (!r2_key) throw new Error("缺少 r2_key");
  const publisher_phone = String((fields && fields.publisher_phone) || "")
    .replace(/\D/g, "")
    .slice(0, 32);
  if (!publisher_phone) throw new Error("缺少 publisher_phone");
  const created_at = nowMs();
  await d1
    .prepare(
      `INSERT INTO ops_documents (
        id, title, original_name, content_type, size_bytes, r2_key,
        publisher_phone, publisher_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      title,
      String((fields && fields.original_name) || "").slice(0, 240),
      String((fields && fields.content_type) || "application/octet-stream").slice(
        0,
        120
      ),
      Number((fields && fields.size_bytes) || 0) || 0,
      r2_key,
      publisher_phone,
      String((fields && fields.publisher_name) || "").slice(0, 80),
      created_at,
      created_at
    )
    .run();
  return getOpsDocument(d1, id);
}

export async function deleteOpsDocument(d1, id) {
  await ensureOpsDocumentsTable(d1);
  const doc = await getOpsDocument(d1, id);
  if (!doc) return null;
  await d1
    .prepare(`DELETE FROM ops_documents WHERE id = ?`)
    .bind(doc.id)
    .run();
  return doc;
}

/** PDF / 纯文本适合浏览器内联阅读；Office 建议下载后用本地 App */
export function opsDocPreferInline(contentType, name) {
  const ct = String(contentType || "").toLowerCase();
  const ext = fileExt(name);
  if (ct.includes("pdf") || ext === "pdf") return true;
  if (ct.startsWith("text/") || ext === "txt" || ext === "md" || ext === "csv") {
    return true;
  }
  return false;
}
