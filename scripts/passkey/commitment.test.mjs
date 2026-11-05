#!/usr/bin/env node
/**
 * Passkey 注册 ceremony 集成测试（测试向量）。
 *
 * 用途（对应本任务 evidence_required）：
 *   1. options → verify 一次完整注册通过（构造 fmt:"none" attestation，ES256 密钥对由
 *      WebCrypto 生成；attestation "none" 无 attestation 签名，故可用虚拟 authenticator 构造）
 *   2. 重复提交同一 challenge（同 ceremony / 同 credential）被拒（一次性消费）
 *   3. origin 不在白名单被拒
 *   4. rpId 不匹配被拒
 *
 * 说明：这里运行的是「生产 Functions 端点」的 onRequest 处理器本身；D1 用 node:sqlite
 * 内存库 + 一个 D1-compatible 适配层（prepare/bind/run/all/first/batch），SQL 由真实
 * migrations/0005_passkey.sql 建表。身份用 issueReauthTicket 直接签发（同 reauth 端点产物）。
 *
 * 运行：node scripts/passkey/commitment.test.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(__dirname, "../../migrations/0005_passkey.sql");

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function encBytes(u8) {
  const n = u8.length;
  let head;
  if (n < 24) head = [0x40 | n];
  else if (n < 0x100) head = [0x58, n];
  else if (n < 0x10000) head = [0x59, (n >> 8) & 0xff, n & 0xff];
  else head = [0x5a, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return Uint8Array.from([...head, ...u8]);
}
function encText(s) {
  const u8 = new TextEncoder().encode(s);
  const n = u8.length;
  let head;
  if (n < 24) head = [0x60 | n];
  else if (n < 0x100) head = [0x78, n];
  else if (n < 0x10000) head = [0x79, (n >> 8) & 0xff, n & 0xff];
  else head = [0x7a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
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
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function b64url(u8) {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function newBytes(n) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}
function u16be(v) {
  return Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
}

// CBOR map: entries = [[encodedKeyBytes, valueBytes], ...]（key 由调用方用 encInt/encText 编码）
function encMap(entries) {
  return concat([mapHead(entries.length), ...entries.map(([k, v]) => concat([k, v]))]);
}
function coseEc2PublicKey(x, y) {
  // COSE_Key { 1:kty=2(EC2), 3:alg=-7(ES256), -1:crv=1(P-256), -2:x, -3:y }
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
  const jwkPub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const decB64url = (s) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "====".slice(0, (4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  return {
    x: decB64url(jwkPub.x),
    y: decB64url(jwkPub.y),
    publicKey: kp.publicKey,
  };
}

// ---------------------------------------------------------------------------
// D1-compatible 内存适配层（真实 SQLite）
// ---------------------------------------------------------------------------
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
    const st = this.db.prepare(this.sql);
    return { results: st.all(...this.params) };
  }
  first() {
    const st = this.db.prepare(this.sql);
    const row = st.get(...this.params);
    return row === undefined ? null : row;
  }
  run() {
    const st = this.db.prepare(this.sql);
    const info = st.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
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
      const results = stmts.map((s) => {
        const st = this.db.prepare(s.sql);
        const info = st.run(...s.params);
        return {
          success: true,
          meta: {
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
          },
        };
      });
      this.db.exec("COMMIT");
      return results;
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
    HMAC_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    PASSKEY_DEBUG_TRACE: "1",
  };
}

async function run() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const d1 = new D1Adapter(db);

  const userKey = "phone:13800138000";
  const userUuid = "8e9b6c7f-1234-4567-89ab-0cdef0123456";

  const env = makeEnv();
  env.hzdvd1 = d1; // 把内存 D1 适配层绑到端点期望的 binding
  const ctx = (url, init) => ({
    request: new Request(url, init),
    env,
    params: {},
  });

  // 用 reauth 票据作为服务端身份（与 /api/passkey/reauth 产物一致）
  const { issueReauthTicket } = await import(
    path.resolve(__dirname, "../../functions/lib/passkey-auth.js")
  );
  const ticket = await issueReauthTicket(env, d1, { userKey, userUuid, mfaLevel: 1 });
  const reauthToken = ticket.token;

  const { onRequest: optionsHandler } = await import(
    path.resolve(__dirname, "../../functions/api/passkey/register/options.js")
  );
  const { onRequest: verifyHandler } = await import(
    path.resolve(__dirname, "../../functions/api/passkey/register/verify.js")
  );
  const { onRequest: listHandler } = await import(
    path.resolve(__dirname, "../../functions/api/passkeys/index.js")
  );

  const results = {
    optionsToVerify: null,
    oneTimeConsumption: null,
    originMismatch: null,
    rpIdMismatch: null,
    list: null,
  };

  // ---------------- 1) options → verify 完整注册 ----------------
  const optionsResp = await optionsHandler(
    ctx("https://hzdv.net/api/passkey/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MacBook", reauthToken }),
    })
  );
  const optionsBody = await optionsResp.json();
  if (!optionsBody.publicKey) {
    console.error("[options] status=", optionsResp.status, "body=", JSON.stringify(optionsBody));
    throw new Error("options did not return publicKey");
  }
  const challenge = optionsBody.publicKey.challenge;
  const ceremonyId = optionsBody.ceremonyId;

  // 构造 fmt:"none" attestation
  const kp = await generateEs256KeyPair();
  const rpIdHash = await sha256(new TextEncoder().encode("hzdv.net"));
  const credentialId = newBytes(32);
  const coseKey = coseEc2PublicKey(kp.x, kp.y);
  const attestedCredentialData = concat([
    new Uint8Array(16), // AAGUID = 零
    u16be(credentialId.length),
    credentialId,
    coseKey,
  ]);
  const flags = 0x41; // UP | AT
  const authData = concat([rpIdHash, Uint8Array.of(flags), Uint8Array.of(0, 0, 0, 0), attestedCredentialData]);
  const attestationObject = encMap([
    [encText("fmt"), encText("none")],
    [encText("authData"), encBytes(authData)],
    [encText("attStmt"), encMap([])], // attStmt = {}
  ]);

  function buildCredential(originOverride, rpIdHashOverride) {
    const clientDataJSONBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin: originOverride || "https://hzdv.net",
      })
    );
    const localAuthData = rpIdHashOverride
      ? concat([rpIdHashOverride, Uint8Array.of(flags), Uint8Array.of(0, 0, 0, 0), attestedCredentialData])
      : authData;
    const localAttestation = encMap([
      [encText("fmt"), encText("none")],
      [encText("authData"), encBytes(localAuthData)],
      [encText("attStmt"), encMap([])],
    ]);
    return {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSONBytes),
        attestationObject: b64url(localAttestation),
        transports: ["internal", "hybrid"],
      },
    };
  }

  // verify 一次
  const verifyResp = await verifyHandler(
    ctx("https://hzdv.net/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ceremonyId,
        reauthToken,
        label: "MacBook",
        credential: buildCredential(),
      }),
    })
  );
  const verifyBody = await verifyResp.json();
  results.optionsToVerify = {
    status: verifyResp.status,
    ok: verifyBody.ok,
    credential: verifyBody.credential,
  };

  // ---------------- 2) 重复提交同一 challenge（一次性消费） ----------------
  const replayResp = await verifyHandler(
    ctx("https://hzdv.net/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ceremonyId,
        reauthToken,
        label: "MacBook",
        credential: buildCredential(),
      }),
    })
  );
  results.oneTimeConsumption = {
    status: replayResp.status,
    ok: (await replayResp.json()).ok,
    note: "same ceremonyId + same credential resubmitted; expected rejected (409/404)",
  };

  // ---------------- 3) origin 不在白名单被拒 ----------------
  // 需要新的 ceremony（上一个已被消费）
  const options2 = await optionsHandler(
    ctx("https://hzdv.net/api/passkey/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "origin-test", reauthToken }),
    })
  );
  const options2Body = await options2.json();
  const verify2Bad = await verifyHandler(
    ctx("https://hzdv.net/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ceremonyId: options2Body.ceremonyId,
        reauthToken,
        credential: buildCredential("https://evil.example"),
      }),
    })
  );
  const verify2BadBody = await verify2Bad.json();
  results.originMismatch = {
    status: verify2Bad.status,
    ok: verify2BadBody.ok,
    note: "clientDataJSON.origin=https://evil.example not in allowlist; expected rejected",
  };

  // ---------------- 4) rpId 不匹配被拒 ----------------
  const options3 = await optionsHandler(
    ctx("https://hzdv.net/api/passkey/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rp-test", reauthToken }),
    })
  );
  const options3Body = await options3.json();
  const evilRpIdHash = await sha256(new TextEncoder().encode("evil.example"));
  const verify3Bad = await verifyHandler(
    ctx("https://hzdv.net/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ceremonyId: options3Body.ceremonyId,
        reauthToken,
        credential: buildCredential("https://hzdv.net", evilRpIdHash),
      }),
    })
  );
  const verify3BadBody = await verify3Bad.json();
  results.rpIdMismatch = {
    status: verify3Bad.status,
    ok: verify3BadBody.ok,
    note: "authenticatorData.rpIdHash=SHA256('evil.example') != SHA256('hzdv.net'); expected rejected",
  };

  // ---------------- 5) 列表应包含已注册 credential ----------------
  const listResp = await listHandler(
    ctx("https://hzdv.net/api/passkeys", {
      method: "GET",
      headers: { Authorization: "Bearer " + reauthToken },
    })
  );
  const listBody = await listResp.json();
  results.list = {
    status: listResp.status,
    ok: listBody.ok,
    count: (listBody.credentials || []).length,
    credentialId: (listBody.credentials || [])[0]?.id,
  };

  console.log(JSON.stringify({ userKey, userUuid, results }, null, 2));

  const pass =
    results.optionsToVerify.status === 200 &&
    results.optionsToVerify.ok === true &&
    results.oneTimeConsumption.status >= 400 &&
    results.originMismatch.status >= 400 &&
    results.rpIdMismatch.status >= 400 &&
    results.list.ok === true &&
    results.list.count >= 1;
  console.log("\n[commitment.test] " + (pass ? "PASS" : "FAIL"));
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error("[commitment.test] error:", e);
  process.exit(1);
});