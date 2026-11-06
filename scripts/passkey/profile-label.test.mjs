#!/usr/bin/env node
/**
 * 个人资料通行密钥标签（passkey / passkey...）回归测试。
 *
 * 覆盖「注册成功后立刻显示 passkey...」的约定：
 *   1. 注册 onSuccess：先 profilePasskeySetLabel(true)，再 profilePasskeyRefreshStatus()
 *   2. refresh 的 catch 分支不得把标签打回 passkey
 *   3. refresh 成功分支按「列表是否有项」改标签；刚注册成功的乐观窗口内
 *      即使列表为空也保留 passkey...
 *   4. 撤销成功清掉乐观窗口（之后列表为空要能回到 passkey）
 *
 * 实现方式：从 lib/user/profile.js 里原样抽出这段函数源码，在最小 stub 环境里执行，
 * 测的是真实源码而不是复制品。
 *
 * 运行：node scripts/passkey/profile-label.test.mjs
 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, "../../lib/user/profile.js"), "utf8");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("ok -", name);
  else { failures++; console.error("FAIL -", name, extra === undefined ? "" : String(extra)); }
}

function block(startMarker, endMarker, from = 0) {
  const start = SRC.indexOf(startMarker, from);
  if (start < 0) return "";
  const end = SRC.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return SRC.slice(start, end);
}

// ── 静态结构断言（锁住关键顺序）──────────────────────────────────────────
const registerBlock = block("function profilePasskeyRegister()", "function profilePasskeyRevoke(");
const setLabelIdx = registerBlock.indexOf("profilePasskeySetLabel(true);");
const refreshIdx = registerBlock.indexOf("profilePasskeyRefreshStatus();");
check("注册 onSuccess 先乐观 SetLabel(true)", setLabelIdx >= 0);
check("注册 onSuccess 再 refresh（顺序在前）", refreshIdx > setLabelIdx, `setLabel@${setLabelIdx} refresh@${refreshIdx}`);
check("注册成功会记录乐观窗口", /profilePasskeyOptimisticAt\s*=\s*Date\.now\(\)/.test(registerBlock));

const refreshBlock = block("function profilePasskeyRefreshStatus()", "function profilePasskeyOpenPanel()");
const catchBlock = block(".catch(function () {", "});", refreshBlock.indexOf(".catch(function () {"));
check("refresh catch 分支不回打标签", catchBlock.length > 0 && !/SetLabel\(false\)/.test(catchBlock));

check("refresh 成功分支按列表项数改标签", /items\.length > 0/.test(refreshBlock));
check("refresh 成功分支存在乐观窗口判断", /optimistic/.test(refreshBlock));

const revokeBlock = block("function profilePasskeyRevoke(", "if (profilePasskeyBtn) {");
check("撤销成功清掉乐观窗口", /profilePasskeyOptimisticAt\s*=\s*0/.test(revokeBlock));

check("声明乐观窗口常量", /PROFILE_PASSKEY_OPTIMISTIC_WINDOW_MS\s*=\s*\d+/.test(SRC));
check("声明乐观时间戳变量", /var profilePasskeyOptimisticAt\s*=\s*0/.test(SRC));

// ── 功能断言：真实源码在 stub 环境里的行为 ────────────────────────────────
const REGION = SRC.slice(
  SRC.indexOf("function profilePasskeyManager()"),
  SRC.indexOf("if (profilePasskeyBtn) {")
);

function makeSandbox(mgr) {
  const btn = { textContent: "passkey" };
  const status = { textContent: "" };
  const summary = { textContent: "" };
  const panel = {
    hidden: true,
    focus() {},
    addEventListener() {},
  };
  const registerBtn = {
    disabled: false,
    textContent: "",
    focus() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
  const sandbox = {
    console,
    Promise,
    Date,
    Math,
    JSON,
    window: { HZDVPasskeyManager: mgr },
    profilePasskeyBtn: btn,
    profilePasskeyStatus: status,
    profilePasskeySummary: summary,
    profilePasskeyPanel: panel,
    profilePasskeyRegisterBtn: registerBtn,
    PROFILE_PASSKEY_OPTIMISTIC_WINDOW_MS: 10000,
    profilePasskeyOptimisticAt: 0,
    profilePasskeyRevoke() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(REGION + "\nglobalThis.__api = { profilePasskeyRefreshStatus, profilePasskeyRegister, profilePasskeyRevoke };", sandbox);
  return { api: sandbox.__api, btn, status };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// 场景 A：刚注册成功，但列表还是空（同步延迟）→ 仍显示 passkey...
{
  const mgr = {
    register(opts) { opts.onSuccess(); },
    async list() { return []; },
    renderSummary() {},
  };
  const { api, btn } = makeSandbox(mgr);
  api.profilePasskeyRegister();
  await tick();
  check("注册成功且列表空 → 仍显示 passkey...", btn.textContent === "passkey...", btn.textContent);
}

// 场景 B：刚注册成功，列表请求失败 → 不回打 passkey
{
  const mgr = {
    register(opts) { opts.onSuccess(); },
    async list() { throw new Error("network"); },
    renderSummary() {},
  };
  const { api, btn } = makeSandbox(mgr);
  api.profilePasskeyRegister();
  await tick();
  check("注册成功但列表失败 → 保留 passkey...", btn.textContent === "passkey...", btn.textContent);
}

// 场景 C：普通刷新（无乐观窗口）+ 列表为空 → 权威结论 passkey
{
  const mgr = {
    async list() { return []; },
    renderSummary() {},
  };
  const { api, btn } = makeSandbox(mgr);
  btn.textContent = "passkey...";
  api.profilePasskeyRefreshStatus();
  await tick();
  check("列表权威为空 → 回到 passkey", btn.textContent === "passkey", btn.textContent);
}

// 场景 D：列表有项 → passkey...
{
  const mgr = {
    async list() { return [{ id: "c1" }]; },
    renderSummary() {},
  };
  const { api, btn } = makeSandbox(mgr);
  btn.textContent = "passkey";
  api.profilePasskeyRefreshStatus();
  await tick();
  check("列表有项 → passkey...", btn.textContent === "passkey...", btn.textContent);
}

// 场景 E：撤销成功后列表为空 → 回到 passkey（乐观窗口已清）
{
  const mgr = {
    register(opts) { opts.onSuccess(); },
    async list() { return []; },
    renderSummary() {},
    revoke(id, opts) { opts.onSuccess(); },
  };
  const { api, btn } = makeSandbox(mgr);
  api.profilePasskeyRegister();
  await tick();
  check("撤销前：仍 passkey...", btn.textContent === "passkey...", btn.textContent);
  api.profilePasskeyRevoke("c1", {});
  await tick();
  check("撤销后列表为空 → 回到 passkey", btn.textContent === "passkey", btn.textContent);
}

if (failures) {
  console.error(`\n[profile-label.test] FAILED (${failures})`);
  process.exitCode = 1;
} else {
  console.log("\n[profile-label.test] PASS");
}
