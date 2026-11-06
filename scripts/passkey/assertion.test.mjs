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
const MIGRATION = path.resolve(__dirname, "../../migrations/0005_passkey.sql");

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
  db.exec(readFileSync(MIGRATION, "utf8"));
  const d1 = new D1Adapter(db);
  const env = makeEnv();
  env.hzdvd1 = d1;

  const ctx = (url, init) => ({ request: new Request(url, init), env, params: {} });

  const { insertCredential, findUserActiveCredentials, getChallenge } = await import(
    path.resolve(__dirname, "../../functions/lib/passkey-d1.js")
  );
  const { onRequest: optionsHandler } = await import(
    path.resolve(__dirname, "../../functions/api/passkey/authenticate/options.js")
  );
  const { onRequest: verifyHandler } = await import(
    path.resolve(__dirname, "../../functions/api/passkey/authenticate/verify.js")
  );

  // 两个用户 + 各自凭据（A 同步 0，B 用于 >0/CAS 测试）
  const userKeyA = "phone:13800138000";
  const userUuidA = "uuid-A";
  const userKeyB = "phone:13900139000";
  const userUuidB = "uuid-B";
  const kpA = await generateEs256KeyPair();
  const kpB = await generateEs256KeyPair();
  const credIdA = b64url(newBytes(32));
  const credIdB = b64url(newBytes(32));
  await insertCredential(d1, {
    userKey: userKeyA, userUuid: userUuidA, credentialId: credIdA,
    publicKeyCose: b64url(coseEc2PublicKey(kpA.x, kpA.y)), algorithm: -7,
    signCount: 0, transports: ["internal", "hybrid"], aaguid: "00000000-0000-0000-0000-000000000000",
    backupEligible: 0, backedUp: 0, userVerified: 0, attestationFormat: "none",
    rpId: "hzdv.net", origin: "https://hzdv.net", label: "A",
  });
  await insertCredential(d1, {
    userKey: userKeyB, userUuid: userUuidB, credentialId: credIdB,
    publicKeyCose: b64url(coseEc2PublicKey(kpB.x, kpB.y)), algorithm: -7,
    signCount: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000",
    backupEligible: 0, backedUp: 0, userVerified: 0, attestationFormat: "none",
    rpId: "hzdv.net", origin: "https://hzdv.net", label: "B",
  });

  const makeOptions = async (phone) => {
    const resp = await optionsHandler(
      ctx("https://hzdv.net/api/passkey/authenticate/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phone ? { phone } : {}),
      })
    );
    const body = await resp.json();
    return { status: resp.status, body };
  };
  const doVerify = async (ceremonyId, credential, extra = {}) => {
    const resp = await verifyHandler(
      ctx(extra.url || "https://hzdv.net/api/passkey/authenticate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ceremonyId, credential }),
      })
    );
    const body = await resp.json();
    return { status: resp.status, body };
  };
  const sessionsFor = async (userKey) => {
    const r = await d1
      .prepare(`SELECT auth_method, user_key FROM auth_sessions WHERE user_key = ? ORDER BY created_at`)
      .bind(userKey)
      .all();
    return r.results;
  };
  const credentialCounter = async (id) => {
    const r = await d1.prepare(`SELECT sign_count FROM passkey_credentials WHERE credential_id = ?`).bind(id).first();
    return r ? Number(r.sign_count) : null;
  };

  const results = { E2: null, E3: null, E4: null, E5: null, E6: null, E7: null };

  // ---- E2: 完整登录 + session 记录（同步 counter=0）----
  let oA = await makeOptions(userKeyA); // phone 收敛
  if (oA.body && Array.isArray(oA.body.publicKey.allowCredentials)) {
    results.E2_allowCredentials_contains_credA = oA.body.publicKey.allowCredentials.some((c) => c.id === credIdA);
  }
  const assertionE2 = await buildAssertion(oA.body.publicKey.challenge, 0, { signKey: kpA.privateKey, id: credIdA });
  const vE2 = await doVerify(oA.body.ceremonyId, assertionE2);
  results.E2 = {
    status: vE2.status,
    ok: vE2.body.ok,
    sessionTokenPresent: typeof vE2.body.sessionToken === "string" && vE2.body.sessionToken.length > 0,
    session: (await sessionsFor(userKeyA)).some((s) => s.auth_method === "session"),
    userKey: vE2.body.user && vE2.body.user.userKey,
  };

  // ---- E3: 同一 assertion 重放第二次被拒 ----
  const replay = await doVerify(oA.body.ceremonyId, assertionE2);
  await sleep(6);
  results.E3 = {
    status: replay.status,
    ok: replay.body.ok,
    note: "same ceremonyId + same assertion replayed; expected rejected",
  };

  // ---- E4: signCount=0 同步 passkey 连续两次登录都成功 ----
  const e4a = await (async () => {
    const o = await makeOptions(userKeyA);
    const a = await buildAssertion(o.body.publicKey.challenge, 0, { signKey: kpA.privateKey, id: credIdA });
    return doVerify(o.body.ceremonyId, a);
  })();
  await sleep(5);
  const e4b = await (async () => {
    const o = await makeOptions(userKeyA);
    const a = await buildAssertion(o.body.publicKey.challenge, 0, { signKey: kpA.privateKey, id: credIdA });
    return doVerify(o.body.ceremonyId, a);
  })();
  results.E4 = {
    firstLogin: e4a.status,
    secondLogin: e4b.status,
    counterAfter: await credentialCounter(credIdA),
    bothOk: e4a.status === 200 && e4b.status === 200,
    note: "sync passkey signCount stays 0; consecutive logins must both succeed",
  };

  // ---- E5: signCount>0 用回退旧值被拒（克隆检测）----
  await d1
    .prepare(`UPDATE passkey_credentials SET sign_count = 10 WHERE credential_id = ?`)
    .bind(credIdB)
    .run();
  const e5 = await (async () => {
    const o = await makeOptions(userKeyB);
    const a = await buildAssertion(o.body.publicKey.challenge, 3, { signKey: kpB.privateKey, id: credIdB });
    return doVerify(o.body.ceremonyId, a);
  })();
  results.E5 = {
    status: e5.status,
    ok: e5.body.ok,
    note: "stored=10, submitted counter=3 (stale); expected rejected (clone)",
  };

  // ---- E6: 未知 credentialId 与签名失败返回完全相同模糊响应 ----
  const e6_unknown = await (async () => {
    const o = await makeOptions(userKeyB);
    const a = await buildAssertion(o.body.publicKey.challenge, 100, { signKey: kpB.privateKey, id: b64url(newBytes(32)) });
    return doVerify(o.body.ceremonyId, a);
  })();
  const e6_badsig = await (async () => {
    const o = await makeOptions(userKeyB);
    const a = await buildAssertion(o.body.publicKey.challenge, 100, { signKey: kpA.privateKey, id: credIdB });
    // stored=10, new=100 > 10 ok, but signature wrong -> library verified:false
    return doVerify(o.body.ceremonyId, a);
  })();
  const sameBody =
    e6_unknown.status === e6_badsig.status &&
    JSON.stringify(e6_unknown.body) === JSON.stringify(e6_badsig.body);
  results.E6 = {
    unknownStatus: e6_unknown.status,
    badSigStatus: e6_badsig.status,
    sameBody,
    unknownBody: e6_unknown.body,
    badSigBody: e6_badsig.body,
    note: "unknown credentialId vs signature failure must be identical",
  };

  // ---- E7: signCount CAS 并发，只有一个成功 ----
  await d1
    .prepare(`UPDATE passkey_credentials SET sign_count = 50 WHERE credential_id = ?`)
    .bind(credIdB)
    .run();
  const o7a = await makeOptions(userKeyB);
  const o7b = await makeOptions(userKeyB);
  const a7a = await buildAssertion(o7a.body.publicKey.challenge, 51, { signKey: kpB.privateKey, id: credIdB });
  const a7b = await buildAssertion(o7b.body.publicKey.challenge, 51, { signKey: kpB.privateKey, id: credIdB });
  const [r7a, r7b] = await Promise.all([
    doVerify(o7a.body.ceremonyId, a7a),
    doVerify(o7b.body.ceremonyId, a7b),
  ]);
  const successes = [r7a, r7b].filter((r) => r.status === 200).length;
  results.E7 = {
    r7a: r7a.status,
    r7b: r7b.status,
    successes,
    counterAfter: await credentialCounter(credIdB),
    onlyOneSuccess: successes === 1,
    note: "concurrent verify CAS: exactly one must win",
  };

  console.log(JSON.stringify({ results }, null, 2));

  const pass =
    (results.E2.status === 200 && results.E2.session === true && results.E2.sessionTokenPresent) &&
    (results.E3.status >= 400) &&
    (results.E4.bothOk === true) &&
    (results.E5.status >= 400) &&
    (results.E6.sameBody === true) &&
    (results.E7.onlyOneSuccess === true);
  console.log("\n[assertion.test] " + (pass ? "PASS" : "FAIL"));
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error("[assertion.test] error:", e);
  process.exit(1);
});