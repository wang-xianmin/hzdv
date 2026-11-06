#!/usr/bin/env node
/**
 * 扫码注册集成测试：桌面 init → 手机 options/create → verify → 桌面 poll。
 * 使用 node:sqlite 内存 D1 适配层和真实 Functions onRequest。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M5 = path.join(ROOT, "migrations/0005_passkey.sql");
const M6 = path.join(ROOT, "migrations/0006_passkey_qr_sessions.sql");
const M7 = path.join(ROOT, "migrations/0007_passkey_qr_register.sql");

function encBytes(u8) {
  const n = u8.length;
  const head = n < 24 ? [0x40 | n] : n < 256 ? [0x58, n] : n < 65536 ? [0x59, (n >> 8) & 255, n & 255] : [0x5a, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([...head, ...u8]);
}
function encInt(n) {
  if (n >= 0) return n < 24 ? Uint8Array.of(n) : n < 256 ? Uint8Array.of(0x18, n) : n < 65536 ? Uint8Array.of(0x19, (n >> 8) & 255, n & 255) : Uint8Array.of(0x1a, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const m = -1 - n;
  return m < 24 ? Uint8Array.of(0x20 | m) : m < 256 ? Uint8Array.of(0x38, m) : Uint8Array.of(0x39, (m >> 8) & 255, m & 255);
}
function encText(s) {
  const u8 = new TextEncoder().encode(s);
  const n = u8.length;
  const head = n < 24 ? [0x60 | n] : n < 256 ? [0x78, n] : [0x79, (n >> 8) & 255, n & 255];
  return Uint8Array.from([...head, ...u8]);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function mapHead(n) { return n < 24 ? Uint8Array.of(0xa0 | n) : n < 256 ? Uint8Array.of(0xb8, n) : Uint8Array.of(0xb9, (n >> 8) & 255, n & 255); }
function encMap(entries) { return concat([mapHead(entries.length), ...entries.map(([k, v]) => concat([k, v]))]); }
function b64url(u8) { return btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function sha256(v) {
  const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
async function hashHex(v) { return Array.from(await sha256(v), (b) => b.toString(16).padStart(2, "0")).join(""); }
function coseEs256(x, y) {
  return encMap([
    [encInt(1), encInt(2)], [encInt(3), encInt(-7)], [encInt(-1), encInt(1)],
    [encInt(-2), encBytes(x)], [encInt(-3), encBytes(y)],
  ]);
}

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...args) { this.params = args; return this; }
  all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  first() { const row = this.db.prepare(this.sql).get(...this.params); return row === undefined ? null : row; }
  run() { const info = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; }
}
class D1Adapter {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => { const info = this.db.prepare(s.sql).run(...s.params); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; });
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

async function run() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(M5, "utf8"));
  db.exec(readFileSync(M6, "utf8"));
  db.exec(readFileSync(M7, "utf8"));
  const d1 = new D1Adapter(db);
  const env = {
    PASSKEY_ENABLED: "true", PASSKEY_RP_ID: "hzdv.net", PASSKEY_RP_NAME: "HZDV",
    PASSKEY_ALLOWED_ORIGINS: "https://hzdv.net,https://www.hzdv.net",
    PASSKEY_REAUTH_TTL_MS: "300000", PASSKEY_CHALLENGE_TTL_MS: "300000",
    PASSKEY_SESSION_TTL_MS: "604800000", HMAC_SECRET: "1".repeat(64),
    ENCRYPTION_KEY: "2".repeat(64), hzdvd1: d1,
  };
  const userKey = "phone:13900001111";
  const userUuid = "uuid-register";
  const sessionToken = "desktop-session-token";
  db.prepare("INSERT INTO auth_sessions (token_hash,user_key,user_uuid,auth_method,mfa_level,created_at,last_seen_at,expires_at) VALUES (?,?,?,'session',1,?,?,?)")
    .run(await hashHex(sessionToken), userKey, userUuid, Date.now(), Date.now(), Date.now() + 60000);
  const ctx = (url, init = {}) => ({ request: new Request(url, { ...init, headers: { Cookie: `hzdv_session=${sessionToken}`, ...(init.headers || {}) } }), env, params: {} });

  const { onRequest: init } = await import(path.join(ROOT, "functions/api/passkey/qr/register/init.js"));
  const { onRequest: options } = await import(path.join(ROOT, "functions/api/passkey/qr/register/options.js"));
  const { onRequest: verify } = await import(path.join(ROOT, "functions/api/passkey/qr/register/verify.js"));
  const { onRequest: poll } = await import(path.join(ROOT, "functions/api/passkey/qr/register/poll.js"));

  const initResp = await init(ctx("https://hzdv.net/api/passkey/qr/register/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  const initBody = await initResp.json();
  if (initResp.status !== 200 || !initBody.session_id) throw new Error(`init failed ${initResp.status}`);
  if (!String(initBody.qr_url).startsWith("https://hzdv.net/passkey/register-scan?sid=")) throw new Error("wrong qr_url");
  const sid = initBody.session_id;
  const row = db.prepare("SELECT flow,user_key,user_uuid FROM passkey_qr_sessions WHERE session_id=?").get(sid);
  if (row.flow !== "register" || row.user_key !== userKey || row.user_uuid !== userUuid) throw new Error("session identity mismatch");

  const optionsResp = await options(ctx(`https://hzdv.net/api/passkey/qr/register/options?sid=${sid}`, { method: "POST" }));
  const optionsBody = await optionsResp.json();
  if (optionsResp.status !== 200 || !optionsBody.publicKey) throw new Error(`options failed ${optionsResp.status}`);
  const challenge = optionsBody.publicKey.challenge;

  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const dec = (s) => { const b = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(b + "====".slice(0, (4 - b.length % 4) % 4)), (c) => c.charCodeAt(0)); };
  const credId = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = await sha256(new TextEncoder().encode("hzdv.net"));
  const authData = concat([rpHash, Uint8Array.of(0x41, 0, 0, 0, 0), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, coseEs256(dec(jwk.x), dec(jwk.y))]);
  const att = encMap([[encText("fmt"), encText("none")], [encText("authData"), encBytes(authData)], [encText("attStmt"), encMap([])]]);
  const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://hzdv.net" }));
  const credential = { id: b64url(credId), rawId: b64url(credId), type: "public-key", response: { clientDataJSON: b64url(cd), attestationObject: b64url(att), transports: ["internal", "hybrid"] } };

  const verifyResp = await verify(ctx(`https://hzdv.net/api/passkey/qr/register/verify?sid=${sid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sid, credential, phone: "evil-phone" }) }));
  const verifyBody = await verifyResp.json();
  if (verifyResp.status !== 200 || !verifyBody.ok) throw new Error(`verify failed ${verifyResp.status}`);
  const cred = db.prepare("SELECT user_key,user_uuid FROM passkey_credentials WHERE credential_id=?").get(b64url(credId));
  if (!cred || cred.user_key !== userKey || cred.user_uuid !== userUuid) throw new Error("credential not bound to session user");
  const completed = db.prepare("SELECT status,flow FROM passkey_qr_sessions WHERE session_id=?").get(sid);
  if (completed.status !== "success" || completed.flow !== "register") throw new Error("session not completed");

  const replayResp = await verify(ctx(`https://hzdv.net/api/passkey/qr/register/verify?sid=${sid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sid, credential }) }));
  if (replayResp.status < 400) throw new Error("replay accepted");
  const pollResp = await poll(ctx(`https://hzdv.net/api/passkey/qr/register/poll?sid=${sid}`));
  const pollBody = await pollResp.json();
  if (pollBody.status !== "success") throw new Error("poll not success");

  console.log("[qr-register.test] PASS");
}

run().catch((e) => { console.error("[qr-register.test] FAIL:", e); process.exit(1); });
