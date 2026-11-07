#!/usr/bin/env node
/**
 * 个人资料通行密钥前端回归测试（不依赖真实 DOM 库，用最小 stub 驱动 passkey-ui.js）。
 *
 * 覆盖：
 *   1. window.HZDVPasskeyManager 导出 list/format/renderSummary/register/revoke
 *   2. 注册顺序契约：先直接 registerPasskey（零弹窗）；仅 401/needReauth 才弹 reauth
 *   3. 撤销必须先 reauth；reauth 浮层为 fixed + z-index 3000 且可滚动
 *   4. 撤销票据经 X-Reauth-Token 请求头传递（DELETE 不带 body）
 *   5. profile 模式成功不触发整页 reload
 *
 * 运行：node scripts/passkey/profile-ui.test.mjs
 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, "../../lib/user/passkey-ui.js"), "utf8");

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    attributes: {},
    handlers: {},
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    insertAdjacentElement(_pos, node) { this.children.push(node); node.parentNode = this; return node; },
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); },
    removeEventListener() {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    closest() { return null; },
    querySelector() { return null; },
    contains() { return false; },
    focus() {},
    scrollIntoView() {},
  };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("ok -", name);
  else { failures++; console.error("FAIL -", name, extra === undefined ? "" : JSON.stringify(extra)); }
}

async function run() {
  const body = makeEl("body");
  globalThis.window = globalThis;
  globalThis.document = {
    body,
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener: () => {},
  };
  globalThis.currentLang = "zh";
  globalThis.PublicKeyCredential = function () {};

  const calls = [];
  let registerShouldFail = false;
  let revokeShouldFail = false;
  let confirmAnswer = true;
  globalThis.confirm = (msg) => { calls.push({ fn: "confirm", msg }); return confirmAnswer; };
  globalThis.HZDVPasskeyAuth = {
    VAGUE_FAIL: "vague",
    listPasskeys: async () => { calls.push({ fn: "list" }); return { credentials: [{ id: "cred-1", name: "MacBook", createdAt: 1750000000000 }] }; },
    revokePasskey: async (id, token) => {
      calls.push({ fn: "revoke", id, token });
      // 无票据且服务端判定无身份 → 401（与真实后端一致：有站点登录态才允许免 reauth 撤销）
      if (revokeShouldFail && !token) {
        const err = new Error("vague");
        err.status = 401;
        err.needReauth = true;
        throw err;
      }
      return { ok: true };
    },
    fetchJSON: async (url, opts) => {
      calls.push({ fn: "fetchJSON", url, method: opts && opts.method, headers: opts && opts.headers, hasBody: !!(opts && opts.body != null) });
      if (url === "/api/passkey/reauth") return { reauthToken: "tk-123" };
      return {};
    },
  };
  globalThis.HZDVPasskeyRegister = {
    registerPasskey: async (body) => {
      calls.push({ fn: "register", body });
      if (registerShouldFail) {
        const err = new Error("vague");
        err.status = 401;
        throw err;
      }
      return { credential: {}, result: {} };
    },
  };

  vm.runInThisContext(SRC);

  const mgr = globalThis.HZDVPasskeyManager;
  check("HZDVPasskeyManager 已导出", !!mgr);
  check("manager 提供 list/register/revoke/renderSummary", !!mgr && ["list", "register", "revoke", "renderSummary"].every((k) => typeof mgr[k] === "function"));

  const list = await mgr.list();
  check("list() 返回凭据数组", Array.isArray(list) && list.length === 1);

  // --- 注册顺序契约 ---
  const registerBtn = makeEl("button");
  let registered = false;
  mgr.register({ triggerButton: registerBtn, onSuccess: () => { registered = true; } });
  await new Promise((r) => setTimeout(r, 10));
  check("有登录态时先直接注册（零弹窗）", calls.some((c) => c.fn === "register") && !body.children.some((c) => c.getAttribute && c.getAttribute("id") === "passkeyReauthPanel"));
  check("注册成功触发 onSuccess", registered);

  // --- 401 才弹 reauth ---
  registerShouldFail = true;
  const registerBtn2 = makeEl("button");
  mgr.register({ triggerButton: registerBtn2 });
  await new Promise((r) => setTimeout(r, 10));
  const panel = body.children.find((c) => c.getAttribute && c.getAttribute("id") === "passkeyReauthPanel");
  check("401 时才弹 reauth", !!panel);
  check("reauth 浮层 fixed + z-index 3000", !!panel && panel.style.position === "fixed" && panel.style.zIndex === "3000");
  check("reauth 浮层可滚动（窄屏不裁剪）", !!panel && panel.style.overflow === "auto" && !!panel.style.maxHeight);

  // --- 撤销：先无票据直撤（站点登录态），仅 401 才回退 reauth 浮层 ---
  const container = makeEl("div");
  let revokedId = null;
  mgr.renderSummary(container, list, { onRevoke: (id) => { revokedId = id; } });
  const revokeBtn = container.children[0].children[1];
  check("撤销按钮带 credentialId", revokeBtn.getAttribute("data-passkey-revoke") === "cred-1");
  check("撤销按钮标记为调用方托管", revokeBtn.getAttribute("data-passkey-revoke-managed") !== null);
  revokeBtn.handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  check("撤销回调收到 credentialId", revokedId === "cred-1");

  const reauthPanels = () => body.children.filter((c) => c.getAttribute && c.getAttribute("id") === "passkeyReauthPanel");

  // 场景 1：用户点「取消」→ 不发任何撤销请求
  calls.length = 0;
  confirmAnswer = false;
  mgr.revoke("cred-1", { triggerButton: revokeBtn, onSuccess: () => calls.push({ fn: "onSuccess" }) });
  await new Promise((r) => setTimeout(r, 20));
  check("撤销弹 confirm 且文案是产品原文", calls.some((c) => c.fn === "confirm" && c.msg === "撤销通行密钥，需要同步删除手机上的hzdv.net私钥"), JSON.stringify(calls.filter((c) => c.fn === "confirm")));
  check("confirm 选 N → 不发撤销请求", !calls.some((c) => c.fn === "revoke"));
  check("confirm 选 N → 不触发 onSuccess", !calls.some((c) => c.fn === "onSuccess"));

  // 场景 2：站点登录态可撤销 → 直接 DELETE（无票据），不弹 reauth 浮层
  calls.length = 0;
  confirmAnswer = true;
  const panelsBefore = reauthPanels().length;
  mgr.revoke("cred-1", { triggerButton: revokeBtn, onSuccess: () => calls.push({ fn: "onSuccess" }) });
  await new Promise((r) => setTimeout(r, 20));
  const directCall = calls.find((c) => c.fn === "revoke");
  check("撤销先走无票据 DELETE（靠站点 Cookie 身份）", !!directCall && !directCall.token, JSON.stringify(directCall));
  check("站点登录态可撤销 → 不弹 reauth 浮层", reauthPanels().length === panelsBefore);
  check("撤销成功触发 onSuccess（不整页 reload）", calls.some((c) => c.fn === "onSuccess"));

  // 场景 3：服务端 401（无站点身份）→ 回退 reauth 浮层，验证通过后带票据重试
  calls.length = 0;
  revokeShouldFail = true;
  mgr.revoke("cred-2", { triggerButton: revokeBtn, onSuccess: () => calls.push({ fn: "onSuccess" }) });
  await new Promise((r) => setTimeout(r, 20));
  check("撤销 401 → 走 reauth 浮层（复用已有浮层，不新建）", reauthPanels().length === panelsBefore);
  check("撤销 401 后尚未成功（等 reauth）", !calls.some((c) => c.fn === "onSuccess"));
  const revokePanel = reauthPanels().pop();
  const phone = revokePanel.children.find((c) => c.getAttribute && c.getAttribute("data-passkey-reauth-phone") !== null);
  const pwd = revokePanel.children.find((c) => c.getAttribute && c.getAttribute("data-passkey-reauth-password") !== null);
  const submit = revokePanel.children[4].children[0];
  phone.value = "13800000000";
  pwd.value = "secret";
  await submit.handlers.click[0]();
  await new Promise((r) => setTimeout(r, 20));

  const revokeCall = calls.find((c) => c.fn === "revoke" && c.token === "tk-123");
  check("撤销票据传给 revokePasskey", !!revokeCall);
  check("撤销请求不带 body（票据走请求头）", !calls.some((c) => c.fn === "fetchJSON" && c.url && c.url.includes("/api/passkeys/") && c.hasBody));
  check("reauth 后撤销成功触发 onSuccess", calls.some((c) => c.fn === "onSuccess"));

  if (failures) {
    console.error(`\n[profile-ui.test] FAILED (${failures})`);
    process.exitCode = 1;
    return;
  }
  console.log("\n[profile-ui.test] PASS");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
