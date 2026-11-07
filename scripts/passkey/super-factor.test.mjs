#!/usr/bin/env node
/**
 * 超管登录「单通道」回归测试。
 *
 * 背景（本次改动的业务目标）：
 *   - 微信扫码 / 通行密钥：超管**单通道即可**登录成功并解锁超管菜单（不再要求相机扫码作为第二步）
 *   - 密码 ↔ 邮箱/相机：仍**互为第二步**（密码是 'a' 因素，邮箱/相机是 'b' 因素）
 *   - 单通道成功后清掉半程凭证 hz_mfa（避免旧半程跨会话被复用）
 *
 * 覆盖：
 *   1. issueSiteAuthToken：超管必须带 mfa=true（否则 requireAuth 判「超管未完成两步」→ 401）
 *   2. superFactorStep：密码半程仍在（同因素不配对、跨因素才签完整令牌、半程不能当令牌用）
 *   3. buildClearMfaCookie：格式（与 buildMfaCookie 同名同路径、Max-Age=0）
 *   4. check-user / auth-claim-scan 端到端：超管密码 → 半程；配对成功 → 完整令牌 + 清 hz_mfa
 *   5. wx-login-poll 端到端：超管微信单通道 → 直接完整令牌（mfa=true），不再返回 super_pending
 *   6. Set-Cookie 必须逐条 append（结构体里传数组会被拼成一条逗号 cookie）
 *   7. 前端源码断言：login.js 无「密码或微信」残留；微信路径不再走 superFactorStep(a)
 *
 * 运行：node scripts/passkey/super-factor.test.mjs
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 复用 session-bridge.test.mjs 的 MockKv / D1Adapter / makeEnv 脚手架
import { MockKv, D1Adapter, makeEnv } from "./session-bridge.test.mjs";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("ok -", name);
  } else {
    failures++;
    console.error("FAIL -", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 从 Cookie 头里取某个 cookie 的值 */
function cookieValue(setCookie, name) {
  const hit = String(setCookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return hit ? hit[1] : "";
}

/** 从 Set-Cookie 头值里取某个 cookie 的值（带属性） */
function setCookieValue(setCookie, name) {
  const hit = String(setCookie || "").match(new RegExp(`^${name}=([^;]*)`));
  return hit ? hit[1] : "";
}

function withCookie(request, name, value) {
  const headers = new Headers(request.headers);
  headers.set("cookie", `${name}=${value}`);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body ? request.body : undefined,
    duplex: request.body ? "half" : undefined,
  });
}

async function run() {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const d1 = new D1Adapter(new DatabaseSync(":memory:"));
  env.hzdvd1 = d1; // 微信扫码交接走 D1（强一致），复现线上路径

  const { writeKvUser, encryptKvInner } = await import(path.resolve(ROOT, "functions/lib/kv-secure.js"));
  const {
    issueAuthToken,
    issueSiteAuthToken,
    verifyAuthToken,
    requireAuth,
    superFactorStep,
    buildAuthCookie,
    buildMfaCookie,
    buildClearMfaCookie,
  } = await import(path.resolve(ROOT, "functions/lib/auth-token.js"));
  const { writeWxuIndex } = await import(path.resolve(ROOT, "functions/lib/wx-index.js"));
  const { createWxScan, markWxScanned } = await import(path.resolve(ROOT, "functions/lib/wx-scan-d1.js"));
  const checkUser = await import(path.resolve(ROOT, "functions/api/check-user.js"));
  const authClaimScan = await import(path.resolve(ROOT, "functions/api/auth-claim-scan.js"));
  const wxLoginPoll = await import(path.resolve(ROOT, "functions/api/wx-login-poll.js"));

  const phone = "13800138000";
  const userKey = "phone:" + phone;
  const userUuid = "8e9b6c7f-1234-4567-89ab-0cdef0123456";
  const pwd = "sup3r-secret";

  // 超管用户（metadata.type=01 → typeMask&1 → isSuper）
  await writeKvUser(
    kv,
    env,
    userKey,
    { uuid: userUuid, name: "boss", email: "boss@hzdv.net", tv: 0, pwd },
    { status: 1, type: "01" }
  );

  const baseReq = () => new Request("https://hzdv.net/api/check-user", { method: "POST" });

  // -------------------------------------------------------------------------
  // 1) issueSiteAuthToken：超管必须带 mfa=true
  // -------------------------------------------------------------------------
  const superIssued = await issueSiteAuthToken(env, phone, { tv: 0, isSuper: true });
  check("issueSiteAuthToken 超管 cookie 以 hz_auth= 开头", superIssued.cookie.startsWith("hz_auth="), superIssued.cookie);
  const superToken = setCookieValue(superIssued.cookie, "hz_auth");
  const superPayload = await verifyAuthToken(env, superToken);
  check("issueSiteAuthToken 超管令牌 mfa=true", !!superPayload && superPayload.mfa === true, superPayload);
  check("issueSiteAuthToken 超管令牌手机号正确", !!superPayload && superPayload.phone === phone, superPayload);

  const normalIssued = await issueSiteAuthToken(env, phone, { tv: 0, isSuper: false });
  const normalToken = setCookieValue(normalIssued.cookie, "hz_auth");
  const normalPayload = await verifyAuthToken(env, normalToken);
  check("issueSiteAuthToken 非超管令牌 mfa=false", !!normalPayload && normalPayload.mfa === false, normalPayload);

  // requireAuth：超管必须 mfa=true，否则被拒（这正是单通道必须带 mfa=true 的原因）
  const authedSuper = await requireAuth({
    request: withCookie(baseReq(), "hz_auth", superToken),
    env,
  });
  check("requireAuth 接受超管 mfa 令牌", !!authedSuper && authedSuper.phone === phone, authedSuper);

  const { token: noMfaToken } = await issueAuthToken(env, phone, { tv: 0 });
  const authedNoMfa = await requireAuth({
    request: withCookie(baseReq(), "hz_auth", noMfaToken),
    env,
  });
  check("requireAuth 拒绝超管非 mfa 令牌", authedNoMfa === null, authedNoMfa);

  // -------------------------------------------------------------------------
  // 2) superFactorStep：密码半程仍在
  // -------------------------------------------------------------------------
  const stepA = await superFactorStep(env, baseReq(), phone, 0, "a");
  check("superFactorStep('a') 首次仍为半程", stepA.full === false, stepA);
  check("superFactorStep('a') 下发 hz_mfa cookie", stepA.cookie.startsWith("hz_mfa="), stepA.cookie);
  check("superFactorStep('a') cookie 路径/有效期正确", /Path=\/api/.test(stepA.cookie) && /Max-Age=600/.test(stepA.cookie), stepA.cookie);

  const reqWithA = withCookie(baseReq(), "hz_mfa", setCookieValue(stepA.cookie, "hz_mfa"));
  const stepAAgain = await superFactorStep(env, reqWithA, phone, 0, "a");
  check("superFactorStep 同因素('a'+'a') 不配对、仍半程", stepAAgain.full === false, stepAAgain);

  const stepB = await superFactorStep(env, baseReq(), phone, 0, "b");
  check("superFactorStep('b') 首次仍为半程", stepB.full === false, stepB);

  const reqWithB = withCookie(baseReq(), "hz_mfa", setCookieValue(stepB.cookie, "hz_mfa"));
  const paired = await superFactorStep(env, reqWithB, phone, 0, "a");
  check("superFactorStep 跨因素('b'+'a') 签完整令牌", paired.full === true, paired);
  const pairedPayload = await verifyAuthToken(env, setCookieValue(paired.cookie, "hz_auth"));
  check("superFactorStep 完整令牌 mfa=true", !!pairedPayload && pairedPayload.mfa === true, pairedPayload);

  // 半程凭证不能当令牌用（fail-closed）
  const mfaOnly = await requireAuth({
    request: withCookie(baseReq(), "hz_mfa", setCookieValue(stepA.cookie, "hz_mfa")),
    env,
  });
  check("半程凭证 hz_mfa 不能当登录令牌", mfaOnly === null, mfaOnly);

  // 半程凭证不可跨手机号配对
  const otherPhone = await superFactorStep(env, reqWithA, "13900139000", 0, "b");
  check("半程凭证不可跨手机号配对", otherPhone.full === false, otherPhone);

  // -------------------------------------------------------------------------
  // 3) buildClearMfaCookie 格式
  // -------------------------------------------------------------------------
  check(
    "buildClearMfaCookie 格式正确",
    buildClearMfaCookie() === "hz_mfa=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    buildClearMfaCookie()
  );
  const mfaName = (buildMfaCookie("x").match(/^([^=]+)=/) || [])[1];
  const clearName = (buildClearMfaCookie().match(/^([^=]+)=/) || [])[1];
  const mfaPath = (buildMfaCookie("x").match(/Path=([^;]+)/) || [])[1];
  const clearPath = (buildClearMfaCookie().match(/Path=([^;]+)/) || [])[1];
  check("清理 cookie 与半程 cookie 同名", mfaName === clearName && clearName === "hz_mfa", { mfaName, clearName });
  check("清理 cookie 与半程 cookie 同路径", mfaPath === clearPath && clearPath === "/api", { mfaPath, clearPath });
  check("清理 cookie Max-Age=0", /Max-Age=0/.test(buildClearMfaCookie()), buildClearMfaCookie());

  // -------------------------------------------------------------------------
  // 4) check-user 端到端：超管密码 → 半程；相机半程配对 → 完整令牌 + 清 hz_mfa
  // -------------------------------------------------------------------------
  const cuReq = () =>
    new Request("https://hzdv.net/api/check-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, password: pwd }),
    });

  const cu1 = await checkUser.onRequest({ request: cuReq(), env });
  const cu1Body = await cu1.json();
  const cu1Cookies = cu1.headers.getSetCookie();
  check("check-user 超管密码校验通过", cu1Body.password_matches === true, cu1Body);
  check("check-user 超管返回 super_pending=true", cu1Body.super_pending === true, cu1Body);
  check("check-user 半程不下发 auth.exp", cu1Body.auth === undefined, cu1Body);
  check("check-user 半程只下发 hz_mfa cookie", cu1Cookies.length === 1 && cu1Cookies[0].startsWith("hz_mfa="), cu1Cookies);

  // 同因素重复：仍是半程
  const cu2 = await checkUser.onRequest({
    request: withCookie(cuReq(), "hz_mfa", setCookieValue(cu1Cookies[0], "hz_mfa")),
    env,
  });
  const cu2Body = await cu2.json();
  check("check-user 重复密码仍是半程", cu2Body.super_pending === true, cu2Body);

  // 相机/邮箱步骤（auth-claim-scan，因素 'b'）
  const nonce = "a".repeat(64);
  const nonceBytes = Buffer.from(nonce, "hex");
  const sessionId = sha256Hex(nonceBytes);
  await kv.put(
    sessionId,
    JSON.stringify({
      emailLoginConfirmed: true,
      confirmMethod: "post",
      phone,
      confirmedAt: Date.now(),
    })
  );
  const claimReq = () =>
    new Request("https://hzdv.net/api/auth-claim-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, phone }),
    });
  const claim1 = await authClaimScan.onRequest({ request: claimReq(), env });
  const claim1Body = await claim1.json();
  const claim1Cookies = claim1.headers.getSetCookie();
  check("auth-claim-scan 相机首步为半程", claim1Body.super_pending === true, claim1Body);
  check("auth-claim-scan 相机首步下发 hz_mfa cookie", claim1Cookies.length === 1 && claim1Cookies[0].startsWith("hz_mfa="), claim1Cookies);

  // 相机半程 + 密码 → 完整令牌（并清 hz_mfa）
  const cu3 = await checkUser.onRequest({
    request: withCookie(cuReq(), "hz_mfa", setCookieValue(claim1Cookies[0], "hz_mfa")),
    env,
  });
  const cu3Body = await cu3.json();
  const cu3Cookies = cu3.headers.getSetCookie();
  check("check-user 相机+密码 配对后不再 super_pending", cu3Body.super_pending === undefined, cu3Body);
  check("check-user 配对后下发 auth.exp", !!cu3Body.auth && typeof cu3Body.auth.exp === "number", cu3Body);
  check("check-user 配对后 Set-Cookie 为两条（hz_auth + 清 hz_mfa）", cu3Cookies.length === 2, cu3Cookies);
  check(
    "check-user 配对后同时下发 hz_auth 与清 hz_mfa",
    cu3Cookies.some((c) => c.startsWith("hz_auth=")) && cu3Cookies.some((c) => c.startsWith("hz_mfa=;") ),
    cu3Cookies
  );
  const cu3Token = setCookieValue(cu3Cookies.find((c) => c.startsWith("hz_auth=")) || "", "hz_auth");
  const cu3Payload = await verifyAuthToken(env, cu3Token);
  check("check-user 配对后令牌 mfa=true", !!cu3Payload && cu3Payload.mfa === true, cu3Payload);
  const cu3Authed = await requireAuth({
    request: withCookie(baseReq(), "hz_auth", cu3Token),
    env,
  });
  check("check-user 配对后令牌可被 requireAuth 接受", !!cu3Authed && cu3Authed.phone === phone, cu3Authed);

  // -------------------------------------------------------------------------
  // 5) wx-login-poll 端到端：超管微信单通道 → 直接完整令牌
  // -------------------------------------------------------------------------
  const scene = "l_" + "b".repeat(24);
  const wxNonce = "c".repeat(64);
  const wxNonceBytes = Buffer.from(wxNonce, "hex");
  const openid = "oSUPER0000000001";
  const now = Date.now();

  await kv.put(`wxlogin:${scene}`, await encryptKvInner(env, { nh: sha256Hex(wxNonceBytes) }));
  await createWxScan(d1, { scene, phone, now });
  await markWxScanned(d1, { scene, wxu: openid, event: "subscribe", now });
  await writeWxuIndex(kv, env, openid, phone, "mp_openid");
  await writeKvUser(
    kv,
    env,
    userKey,
    { uuid: userUuid, name: "boss", email: "boss@hzdv.net", tv: 0, wxu: openid },
    { status: 1, type: "01" }
  );

  const wxReq = () =>
    new Request("https://hzdv.net/api/wx-login-poll", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hz_wxl=${wxNonce}` },
      body: JSON.stringify({ scene }),
    });
  const wxRes = await wxLoginPoll.onRequest({ request: wxReq(), env });
  const wxBody = await wxRes.json();
  const wxCookies = wxRes.headers.getSetCookie();
  check("wx-login-poll 登录成功", wxBody.status === "ok", wxBody);
  check("wx-login-poll 识别为超管", wxBody.is_superuser === true, wxBody);
  check("wx-login-poll 单通道不再返回 super_pending", wxBody.super_pending === undefined, wxBody);
  check("wx-login-poll 下发 auth.exp", !!wxBody.auth && typeof wxBody.auth.exp === "number", wxBody);
  check(
    "wx-login-poll Set-Cookie 含 hz_auth",
    wxCookies.some((c) => c.startsWith("hz_auth=")),
    wxCookies
  );
  check(
    "wx-login-poll Set-Cookie 含清 hz_mfa",
    wxCookies.some((c) => c.startsWith("hz_mfa=;")),
    wxCookies
  );
  check(
    "wx-login-poll Set-Cookie 含清 hz_wxl",
    wxCookies.some((c) => c.startsWith("hz_wxl=;")),
    wxCookies
  );
  const wxToken = setCookieValue(wxCookies.find((c) => c.startsWith("hz_auth=")) || "", "hz_auth");
  const wxPayload = await verifyAuthToken(env, wxToken);
  check("wx-login-poll 超管令牌 mfa=true", !!wxPayload && wxPayload.mfa === true, wxPayload);
  const wxAuthed = await requireAuth({
    request: withCookie(baseReq(), "hz_auth", wxToken),
    env,
  });
  check("wx-login-poll 超管令牌可被 requireAuth 接受", !!wxAuthed && wxAuthed.phone === phone, wxAuthed);

  // -------------------------------------------------------------------------
  // 6) Set-Cookie 必须逐条 append（结构体里传数组会被拼成一条）
  // -------------------------------------------------------------------------
  const joined = new Response("x", {
    headers: { "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] },
  });
  check(
    "回归依据：Headers 结构体传数组会被拼成单条 cookie",
    joined.headers.getSetCookie().length === 1,
    joined.headers.getSetCookie()
  );
  const appended = new Response("x");
  appended.headers.append("Set-Cookie", "a=1; Path=/");
  appended.headers.append("Set-Cookie", "b=2; Path=/");
  check("逐条 append 产生两条独立 cookie", appended.headers.getSetCookie().length === 2, appended.headers.getSetCookie());

  // -------------------------------------------------------------------------
  // 7) 前端/后端源码断言
  // -------------------------------------------------------------------------
  const loginJs = readFileSync(path.resolve(ROOT, "lib/user/login.js"), "utf8");
  check("login.js 无「密码或微信」残留", !loginJs.includes("密码或微信"), null);
  check("login.js 无「微信或密码」残留", !loginJs.includes("微信或密码"), null);
  check("login.js 提示改为「还需要密码验证」", loginJs.includes("还需要密码验证"), null);
  check("login.js 进度文案改为「密码√/密码×」", loginJs.includes("'密码√'") && loginJs.includes("'密码×'"), null);
  check("login.js 微信单通道分支存在", loginJs.includes("super_pending === true") && loginJs.includes("setAdminMenusVisible(true)"), null);

  const wxPollSrc = readFileSync(path.resolve(ROOT, "functions/api/wx-login-poll.js"), "utf8");
  check("wx-login-poll.js 不再引用 superFactorStep", !wxPollSrc.includes("superFactorStep"), null);
  check("wx-login-poll.js 改用 issueSiteAuthToken", wxPollSrc.includes("issueSiteAuthToken"), null);

  const checkUserSrc = readFileSync(path.resolve(ROOT, "functions/api/check-user.js"), "utf8");
  check("check-user.js 仍走 superFactorStep('a')", checkUserSrc.includes('superFactorStep(env, request, phone, tv, "a")'), null);

  const claimSrc = readFileSync(path.resolve(ROOT, "functions/api/auth-claim-scan.js"), "utf8");
  check("auth-claim-scan.js 仍走 superFactorStep('b')", claimSrc.includes('superFactorStep(env, request, phoneStr, tv, "b")'), null);

  const passkeyQrJs = readFileSync(path.resolve(ROOT, "lib/user/passkey-qr.js"), "utf8");
  check("passkey-qr.js 显式解锁超管菜单", passkeyQrJs.includes("setAdminMenusVisible(true)") && passkeyQrJs.includes("0x01"), null);

  if (failures) {
    console.error(`\n[super-factor.test] FAILED (${failures})`);
    process.exitCode = 1;
    return;
  }
  console.log("\n[super-factor.test] PASS");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
