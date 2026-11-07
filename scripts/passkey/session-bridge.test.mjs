#!/usr/bin/env node
/**
 * 站点 auth-token 桥接回归测试（个人资料「已登录免再输手机号/密码」）。
 *
 * 覆盖 resolveIdentity 的身份优先级与桥接边界：
 *   1. hzdv_session 会话优先（kind=session）
 *   2. reauth 票据优先于 auth-token（kind=reauth）
 *   3. 都没有时，站点 auth-token（hz_auth Cookie / Bearer）可映射出
 *      {userKey:'phone:…', userUuid:KV 里的 uuid}（kind=auth_token）
 *   4. 敏感操作显式关闭桥接（allowSiteToken:false）时，auth-token 不被接受
 *   5. 无任何凭据 → null（fail-closed）
 *
 * 运行：node scripts/passkey/session-bridge.test.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const MIGRATION = path.resolve(ROOT, "migrations/0005_passkey.sql");

// ---------------------------------------------------------------------------
// 最小 D1 适配层（node:sqlite 内存库）
// ---------------------------------------------------------------------------
/** 设为某个 token 的 sha256 hex 时，该 token 的查询会抛错（模拟坏候选） */
let THROW_ON_TOKEN_HASH = null;

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
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true };
  }
  async first() {
    // 模拟「坏候选」：某个 token 的查询直接抛错（D1 抖动 / 脏数据）
    if (THROW_ON_TOKEN_HASH && this.params[0] === THROW_ON_TOKEN_HASH) {
      throw new Error("d1 boom for bad token");
    }
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async run() {
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
  async batch(stmts) {
    const results = [];
    for (const s of stmts) results.push(await s.run());
    return results;
  }
}

// ---------------------------------------------------------------------------
// 最小 KV 适配层（Workers KV 语义：getWithMetadata / put / delete / list）
// ---------------------------------------------------------------------------
class MockKv {
  constructor() {
    this.map = new Map();
  }
  async getWithMetadata(key) {
    const hit = this.map.get(key);
    if (!hit) return { value: null, metadata: null };
    return { value: hit.value, metadata: hit.metadata };
  }
  async get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    return {
      value: null,
      metadata: hit.metadata,
      text: async () => String(hit.value),
      json: async () => JSON.parse(String(hit.value)),
    };
  }
  async put(key, value, opts) {
    this.map.set(key, { value, metadata: opts && opts.metadata });
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list() {
    return { keys: Array.from(this.map.keys()).map((name) => ({ name })) };
  }
}

function makeEnv(kv) {
  return {
    PASSKEY_ENABLED: "true",
    PASSKEY_RP_ID: "hzdv.net",
    PASSKEY_RP_NAME: "HZDV",
    PASSKEY_ALLOWED_ORIGINS: "https://hzdv.net,https://www.hzdv.net",
    PASSKEY_REAUTH_TTL_MS: "300000",
    PASSKEY_CHALLENGE_TTL_MS: "300000",
    HMAC_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dv_kv: kv,
  };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("ok -", name);
  } else {
    failures++;
    console.error("FAIL -", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

async function run() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const d1 = new D1Adapter(db);
  const kv = new MockKv();
  const env = makeEnv(kv);
  env.hzdvd1 = d1; // 内存 D1 绑定（会话/reauth 票据都落这里）

  const { writeKvUser } = await import(path.resolve(ROOT, "functions/lib/kv-secure.js"));
  const { issueAuthToken } = await import(path.resolve(ROOT, "functions/lib/auth-token.js"));
  const {
    resolveIdentity,
    issueReauthTicket,
    createAuthSession,
  } = await import(path.resolve(ROOT, "functions/lib/passkey-auth.js"));

  const phone = "13800138000";
  const userKey = "phone:" + phone;
  const userUuid = "8e9b6c7f-1234-4567-89ab-0cdef0123456";

  await writeKvUser(kv, env, userKey, { uuid: userUuid, name: "tester", tv: 0 }, { status: 1 });

  const url = "https://hzdv.net/api/passkey/register/options";
  const withCookie = (name, value) =>
    new Request(url, { headers: { cookie: `${name}=${value}` } });

  // 1) auth-token 桥接（hz_auth Cookie）
  const { token: authToken } = await issueAuthToken(env, phone, { tv: 0 });
  const bridged = await resolveIdentity(env, d1, withCookie("hz_auth", authToken), {});
  check("auth-token 桥接出 userKey", bridged && bridged.userKey === userKey, bridged);
  check("auth-token 桥接出 userUuid", bridged && bridged.userUuid === userUuid, bridged);
  check("auth-token 桥接 kind=auth_token", bridged && bridged.kind === "auth_token", bridged);

  // 2) Bearer 形式的 auth-token 也能桥接
  const bearerReq = new Request(url, { headers: { authorization: "Bearer " + authToken } });
  const bridgedBearer = await resolveIdentity(env, d1, bearerReq, {});
  check("Bearer auth-token 桥接成功", bridgedBearer && bridgedBearer.userKey === userKey, bridgedBearer);

  // 3) 敏感操作可显式关闭桥接
  const noBridge = await resolveIdentity(env, d1, withCookie("hz_auth", authToken), {}, { allowSiteToken: false });
  check("allowSiteToken:false 时 auth-token 不被接受", noBridge === null, noBridge);

  // 4) 无任何凭据 → null
  const none = await resolveIdentity(env, d1, new Request(url), {});
  check("无凭据返回 null", none === null, none);

  // 5) reauth 票据优先于 auth-token
  const { token: reauthToken } = await issueReauthTicket(env, d1, { userKey, userUuid, mfaLevel: 1 });
  const reauthFirst = await resolveIdentity(
    env,
    d1,
    withCookie("hz_auth", authToken),
    { reauthToken }
  );
  check("reauth 票据优先", reauthFirst && reauthFirst.kind === "reauth", reauthFirst);

  // 6) passkey 会话优先于 auth-token
  const { token: sessionToken } = await createAuthSession(d1, { userKey, userUuid, mfaLevel: 1 });
  const sessionFirst = await resolveIdentity(
    env,
    d1,
    withCookie("hzdv_session", sessionToken),
    {}
  );
  check("hzdv_session 会话优先", sessionFirst && sessionFirst.kind === "session", sessionFirst);

  // 7) 失效/伪造的 auth-token 不通过
  const forged = authToken.slice(0, -2) + "00";
  const forgedId = await resolveIdentity(env, d1, withCookie("hz_auth", forged), {});
  check("伪造 auth-token 被拒", forgedId === null, forgedId);

  // 8) 坏候选（校验抛错）不能阻断站点 auth-token 兜底
  //    hzdv_session 排在 auth-token 之前；若它抛错就整段失败，
  //    站点登录态明明有效也会被打成 401（个人资料 edit 一直显示 passkey 的原因之一）。
  {
    const badToken = "bad-session-token";
    const badHash = createHash("sha256").update(badToken).digest("hex");
    THROW_ON_TOKEN_HASH = badHash;
    try {
      const req = new Request(url, {
        headers: { cookie: `hzdv_session=${badToken}; hz_auth=${authToken}` },
      });
      const afterBad = await resolveIdentity(env, d1, req, {});
      check("坏 session 候选抛错 → 仍用站点 auth-token 兜底", afterBad && afterBad.kind === "auth_token", afterBad);
      check("坏 session 候选抛错 → userKey 正确", afterBad && afterBad.userKey === userKey, afterBad);
    } finally {
      THROW_ON_TOKEN_HASH = null;
    }
  }

  if (failures) {
    console.error(`\n[session-bridge.test] FAILED (${failures})`);
    process.exitCode = 1;
    return;
  }
  console.log("\n[session-bridge.test] PASS");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
