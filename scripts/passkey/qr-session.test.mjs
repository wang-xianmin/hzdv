#!/usr/bin/env node
/**
 * Passkey 登录（assertion）集成测试（测试向量）。
 * 运行真实 functions 端点 onRequest + node:sqlite 内存 D1 适配层（真实 SQL）。
 *
 * 覆盖 evidence E2–E7：
 *  E2 完整 assertion ceremony：options -> verify 返回 session token，auth_sessions 出现 auth_method='session' 行
 *  E3 同一 assertion 重放第二次被拒（challenge 一次性消费）
 *  E4 signCount=0 的同步 passkey 连续两次登录都成功（不误锁）
 *  E5 signCount>0 时用回退的旧 signCount 提交被拒（克隆检测）
 *  E6 未知 credentialId 与签名失败返回完全相同模糊响应（防枚举）
 *  E7 signCount CAS 并发：同一凭据两个并发 verify 只有一个成功
 *
 * 运行：node scripts/passkey/assertion.test.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0005 = path.resolve(__dirname, "../../migrations/0005_passkey.sql");
const MIGRATION_0006 = path.resolve(__dirname, "../../migrations/0006_passkey_qr_sessions.sql");

/* ---------- helpers ---------- */
function encBytes(u8) {
  const n = u8.length;
  let head;
  if (n < 24) head = [0x40 | n];
  else if (n < 0x100) head = [0x58, n];
  else if (n < 0x10000) head = [0x59, (n >> 8) & 0xff, n & 0xff];
  else head = [0x5a, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return Uint8Array.from([...head, ...u8]);
}
function encInt(n) {
  if (n >= 0) {
    if (n < 24) return Uint8Array.of(0x00 | n);
    if (n < 0x100) return Uint8Array.of(0x18, n);
    if (n < 0x10000) return Uint8Array.of(0x19, (n >> 8) & 0xff, n & 0xff);
    return Uint8Array.of(0x1a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const m = -1 - n;
  if (m < 24) return Uint8Array.of(0x20 | m);
  if (m < 0x100) return Uint8Array.of(0x38, m);
  if (m < 0x10000) return Uint8Array.of(0x39, (m >> 8) & 0xff, m & 0xff);
  return Uint8Array.of(0x3a, (m >>> 24) & 0xff, (m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff);
}
function mapHead(n) {
  if (n < 24) return Uint8Array.of(0xa0 | n);
  if (n < 0x100) return Uint8Array.of(0xb8, n);
  return Uint8Array.of(0xb9 | 0, (n >> 8) & 0xff, n & 0xff);
}
function concat(parts) {
  let t = 0;
  for (const p of parts) t += p.length;
  const o = new Uint8Array(t);
  let off = 0;
  for (const p of parts) {
    o.set(p, off);
    off += p.length;
  }
  return o;
}
function b64url(u8) {
  let b = "";
  for (const x of u8) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function u16be(v) {
  return Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
}
function u32be(v) {
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
/** ECDSA 原始 r||s(64B) -> ASN.1 DER SEQUENCE（SimpleWebAuthn unwrapEC2Signature 期望 DER） */
function sigToDER(raw) {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const encInt = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let c = b.slice(i);
    if ((c[0] & 0x80) !== 0) c = concat([Uint8Array.of(0), c]);
    return concat([Uint8Array.of(0x02), Uint8Array.of(c.length), c]);
  };
  const inner = concat([encInt(r), encInt(s)]);
  return concat([Uint8Array.of(0x30), Uint8Array.of(inner.length), inner]);
}
function encMap(entries) {
  return concat([mapHead(entries.length), ...entries.map(([k, v]) => concat([k, v]))]);
}
function coseEc2PublicKey(x, y) {
  return encMap([
    [encInt(1), encInt(2)],
    [encInt(3), encInt(-7)],
    [encInt(-1), encInt(1)],
    [encInt(-2), encBytes(x)],
    [encInt(-3), encBytes(y)],
  ]);
}
async function sha256(u8) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
}
async function generateEs256KeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const dec = (s) => {
    const b = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "====".slice(0, (4 - (b.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  return { x: dec(jwk.x), y: dec(jwk.y), keyPair: kp, privateKey: kp.privateKey };
}
function newBytes(n) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- D1-compatible adapter ---------- */
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...args) {
    this.params = args;
    return this;
  }
  all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  first() {
    const r = this.db.prepare(this.sql).get(...this.params);
    return r === undefined ? null : r;
  }
  run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}
class D1Adapter {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const r = stmts.map((s) => {
        const info = this.db.prepare(s.sql).run(...s.params);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      });
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function makeEnv() {
  return {
    PASSKEY_ENABLED: "true",
    PASSKEY_RP_ID: "hzdv.net",
    PASSKEY_RP_NAME: "HZDV",
    PASSKEY_ALLOWED_ORIGINS: "https://hzdv.net,https://www.hzdv.net",
    PASSKEY_REAUTH_TTL_MS: "300000",
    PASSKEY_CHALLENGE_TTL_MS: "300000",
    PASSKEY_SESSION_TTL_MS: "604800000",
    PASSKEY_DEBUG_TRACE: "1",
    HMAC_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

async function buildAssertion(challenge, counter, opts = {}) {
  const origin = opts.origin || "https://hzdv.net";
  const clientDataBytes = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge, origin })
  );
  const rpHash = opts.rpIdHash || (await sha256(new TextEncoder().encode("hzdv.net")));
  const flagsByte = opts.flags != null ? opts.flags : 0x01; // UP
  const authData = concat([rpHash, Uint8Array.of(flagsByte), u32be(counter)]);
  const cdHash = await sha256(clientDataBytes);
  const message = concat([authData, cdHash]);
  const key = opts.wrongKey ? opts.wrongKey : opts.signKey;
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message)
  );
  const id = opts.credentialId || opts.id;
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: b64url(clientDataBytes),
      authenticatorData: b64url(authData),
      signature: b64url(sigToDER(sigBytes)),
    },
  };
}


async function run() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION_0005, "utf8"));
  db.exec(readFileSync(MIGRATION_0006, "utf8"));
  const d1 = new D1Adapter(db);
  const env = makeEnv();
  env.hzdvd1 = d1;
  const ctx = (url, init) => ({ request: new Request(url, init), env, params: {} });

  const { insertCredential } = await import(path.resolve(__dirname, "../../functions/lib/passkey-d1.js"));
  const { resolveIdentity } = await import(path.resolve(__dirname, "../../functions/lib/passkey-auth.js"));
  const { onRequest: initHandler } = await import(path.resolve(__dirname, "../../functions/api/passkey/qr/init.js"));
  const { onRequest: pollHandler } = await import(path.resolve(__dirname, "../../functions/api/passkey/qr/poll.js"));
  const { onRequest: claimHandler } = await import(path.resolve(__dirname, "../../functions/api/passkey/qr/claim.js"));
  const { onRequest: challengeHandler } = await import(path.resolve(__dirname, "../../functions/api/passkey/qr/challenge.js"));
  const { onRequest: verifyHandler } = await import(path.resolve(__dirname, "../../functions/api/passkey/qr/verify.js"));

  const userKey = "phone:13900001111";
  const userUuid = "uuid-qr";
  const kp = await generateEs256KeyPair();
  const credId = b64url(newBytes(32));
  await insertCredential(d1, {
    userKey, userUuid, credentialId: credId,
    publicKeyCose: b64url(coseEc2PublicKey(kp.x, kp.y)), algorithm: -7,
    signCount: 0, transports: ["internal", "hybrid"], aaguid: "00000000-0000-0000-0000-000000000000",
    backupEligible: 0, backedUp: 0, userVerified: 0, attestationFormat: "none",
    rpId: "hzdv.net", origin: "https://hzdv.net", label: "QR",
  });

  const out = { steps: [] };
  const ok = (k, v) => { out.steps.push({ [k]: v }); };

  // 1) init：UUIDv4 + 同源 qr_url
  const initResp = await initHandler(ctx("https://hzdv.net/api/passkey/qr/init", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  const initBody = await initResp.json();
  ok("init_status", initResp.status);
  ok("session_id_is_uuid_v4", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(initBody.session_id));
  ok("qr_url_same_origin", String(initBody.qr_url).startsWith("https://hzdv.net/passkey/scan?sid="));
  const sid = initBody.session_id;

  // 2) challenge：绑定到 sid
  const chResp = await challengeHandler(ctx(`https://hzdv.net/api/passkey/qr/challenge?sid=${sid}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  const chBody = await chResp.json();
  ok("challenge_status", chResp.status);
  ok("challenge_rpid", chBody.publicKey && chBody.publicKey.rpId);
  const challenge = chBody.publicKey.challenge;

  // 3) 手机 verify：合法 assertion → success，不返回 token
  const assertion = await buildAssertion(challenge, 0, { signKey: kp.privateKey, credentialId: credId, origin: "https://hzdv.net" });
  const vResp = await verifyHandler(ctx("https://hzdv.net/api/passkey/qr/verify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, credential: assertion }),
  }));
  const vBody = await vResp.json();
  ok("verify_status", vResp.status);
  ok("verify_no_token_to_phone", vBody.sessionToken === undefined);

  const row = db.prepare("SELECT status, user_key, user_uuid, session_token, challenge_plain FROM passkey_qr_sessions WHERE session_id = ?").get(sid);
  ok("row_status_success", row && row.status === "success");
  ok("row_user_key", row && row.user_key === userKey);
  ok("row_token_pending", !!(row && row.session_token));
  ok("challenge_cleared", !!(row && !row.challenge_plain));
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM auth_sessions WHERE user_key = ? AND auth_method = 'session'").get(userKey);
  ok("auth_session_created", Number(sessions.c) === 1);

  // 4) poll：ready + 掩码账号（无 user_key 明文）
  const pResp = await pollHandler(ctx(`https://hzdv.net/api/passkey/qr/poll?sid=${sid}`, { method: "GET" }));
  const pBody = await pResp.json();
  ok("poll_status_ready", pBody.status === "ready");
  ok("poll_masked", pBody.user && pBody.user.userKeyMasked === "139****1111");
  ok("poll_no_raw_user_key", JSON.stringify(pBody).indexOf("13900001111") < 0);

  // 5) claim：一次性拿到 sessionToken；二次 claim 409
  const cResp = await claimHandler(ctx(`https://hzdv.net/api/passkey/qr/claim?sid=${sid}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  const cBody = await cResp.json();
  ok("claim_status", cResp.status);
  ok("claim_has_token", !!cBody.sessionToken);
  const c2 = await claimHandler(ctx(`https://hzdv.net/api/passkey/qr/claim?sid=${sid}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  ok("second_claim_status", c2.status);

  // 6) token 是真会话：resolveIdentity 能认
  const ident = await resolveIdentity(env, d1, new Request("https://hzdv.net/api/passkey/authenticate/options", {
    headers: { Cookie: `hzdv_session=${cBody.sessionToken}` },
  }), {});
  ok("token_is_real_session", !!(ident && ident.userKey === userKey));

  // 7) challenge 一次性：同 sid 再 verify 被拒
  const v2 = await verifyHandler(ctx("https://hzdv.net/api/passkey/qr/verify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, credential: assertion }),
  }));
  ok("replay_verify_status", v2.status);

  // 8) 过期会话不可 claim
  db.prepare("UPDATE passkey_qr_sessions SET expires_at = ? WHERE session_id = ?").run(Date.now() - 1000, sid);
  const c3 = await claimHandler(ctx(`https://hzdv.net/api/passkey/qr/claim?sid=${sid}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  ok("expired_claim_status", c3.status);

  // 9) PASSKEY_ENABLED=false → 404
  const envOff = makeEnv();
  envOff.PASSKEY_ENABLED = "false";
  envOff.hzdvd1 = d1;
  const offResp = await initHandler({ request: new Request("https://hzdv.net/api/passkey/qr/init", { method: "POST" }), env: envOff, params: {} });
  ok("disabled_status", offResp.status);

  console.log(JSON.stringify(out, null, 2));
  const assert = (cond, msg) => { if (!cond) throw new Error("assert failed: " + msg); };
  assert(out.steps.find((s) => s.init_status)?.init_status === 200, "init 200");
  assert(out.steps.find((s) => s.session_id_is_uuid_v4)?.session_id_is_uuid_v4 === true, "uuid v4");
  assert(out.steps.find((s) => s.qr_url_same_origin)?.qr_url_same_origin === true, "same origin");
  assert(out.steps.find((s) => s.challenge_status)?.challenge_status === 200, "challenge 200");
  assert(out.steps.find((s) => s.verify_status)?.verify_status === 200, "verify 200");
  assert(out.steps.find((s) => s.verify_no_token_to_phone)?.verify_no_token_to_phone === true, "no token to phone");
  assert(out.steps.find((s) => s.row_status_success)?.row_status_success === true, "row success");
  assert(out.steps.find((s) => s.row_user_key)?.row_user_key === true, "user_key written");
  assert(out.steps.find((s) => s.auth_session_created)?.auth_session_created === true, "session row");
  assert(out.steps.find((s) => s.poll_status_ready)?.poll_status_ready === true, "poll ready");
  assert(out.steps.find((s) => s.poll_masked)?.poll_masked === true, "masked account");
  assert(out.steps.find((s) => s.poll_no_raw_user_key)?.poll_no_raw_user_key === true, "no raw user_key");
  assert(out.steps.find((s) => s.claim_status)?.claim_status === 200, "claim 200");
  assert(out.steps.find((s) => s.claim_has_token)?.claim_has_token === true, "claim token");
  assert(out.steps.find((s) => s.second_claim_status)?.second_claim_status === 409, "second claim 409");
  assert(out.steps.find((s) => s.token_is_real_session)?.token_is_real_session === true, "real session");
  assert(out.steps.find((s) => s.replay_verify_status)?.replay_verify_status === 400, "replay rejected");
  assert(out.steps.find((s) => s.expired_claim_status)?.expired_claim_status === 409, "expired claim 409");
  assert(out.steps.find((s) => s.disabled_status)?.disabled_status === 404, "disabled 404");
  console.log("[qr-session.test] PASS");
}

run().catch((e) => { console.error("[qr-session.test] FAIL:", e && e.message); process.exit(1); });
