/**
 * GET /api/email-login-confirm?token=...
 * 用户点击邮件按钮后进入此页：校验 token，核对 KV 中手机号与邮箱是否一致，
 * 一致则标记扫码会话已确认，电脑端轮询后完成登录；不一致则提示「手机号错！」。
 */

import { pickKvBinding, kvBindingHint } from "../lib/kv-binding.js";
import { assertPhoneKey, readKvUser } from "../lib/kv-secure.js";

function htmlPage(title, bodyHtml, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#f5f5f5;}
    .card{max-width:420px;margin:24px;padding:28px 24px;border-radius:16px;background:#1a1d24;text-align:center;}
    h1{font-size:1.25rem;margin:0 0 12px;}
    p{margin:0;line-height:1.6;color:#b8bdc8;font-size:0.95rem;}
    .ok{color:#3dd68c;}
    .err{color:#ff7b72;}
  </style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function normalizeEmail(v) {
  const raw = String(v || "").trim().toLowerCase();
  if (!raw || raw.indexOf("@") < 0) return raw;
  const at = raw.lastIndexOf("@");
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return local + "@" + domain;
}

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function phoneEmailMatchInKv(kv, env, phone, email) {
  const digits = normalizePhoneDigits(phone);
  const wantEmail = normalizeEmail(email);
  if (!digits || !wantEmail) return false;
  const key = "phone:" + digits;
  try {
    assertPhoneKey(key);
  } catch (e) {
    return false;
  }
  let row = null;
  try {
    row = await readKvUser(kv, env, key);
  } catch (e) {
    console.error("[email-login-confirm] readKvUser failed:", e);
    return false;
  }
  if (!row || !row.value) return false;
  const stored = normalizeEmail(row.value.email);
  return !!stored && stored === wantEmail;
}

async function writeSessionPhoneMismatch(kv, sessionId, link) {
  const phoneMismatchAt = Date.now();
  let sessionData = {
    scanned: true,
    emailLoginPending: false,
    emailLoginConfirmed: false,
    emailLoginPhoneMismatch: true,
    phoneMismatchAt,
    email: (link && link.email) || "",
    phone: (link && link.phone) || "",
    username: (link && link.username) || "",
  };
  try {
    const prev = await kv.get(sessionId);
    if (prev) {
      const j = JSON.parse(prev);
      if (j && typeof j === "object") {
        sessionData = {
          ...j,
          ...sessionData,
          emailLoginConfirmed: false,
          emailLoginPending: false,
          emailLoginPhoneMismatch: true,
          phoneMismatchAt,
        };
      }
    }
  } catch (e) {}
  await kv.put(sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "POST") {
    return htmlPage("错误", "<h1 class='err'>Method Not Allowed</h1>", 405);
  }

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  if (!token) {
    return htmlPage(
      "链接无效",
      "<h1 class='err'>链接无效</h1><p>缺少确认参数，请回到电脑端重新扫码登录。</p>",
      400
    );
  }

  const kv = pickKvBinding(env);
  if (!kv) {
    return htmlPage(
      "服务未配置",
      `<h1 class='err'>服务未配置</h1><p>${kvBindingHint()}</p>`,
      503
    );
  }

  const raw = await kv.get("elink:" + token);
  if (!raw) {
    return htmlPage(
      "链接已失效",
      "<h1 class='err'>链接已失效</h1><p>请回到电脑端重新扫码，并查收新的确认邮件。</p>",
      410
    );
  }

  let link;
  try {
    link = JSON.parse(raw);
  } catch (e) {
    link = null;
  }
  if (!link || !link.sessionId) {
    return htmlPage(
      "链接无效",
      "<h1 class='err'>链接无效</h1><p>请回到电脑端重新扫码登录。</p>",
      400
    );
  }

  // 一次性链接：无论成功失败都消费，避免重复点击绕过
  await kv.delete("elink:" + token);

  const matched = await phoneEmailMatchInKv(kv, env, link.phone, link.email);
  if (!matched) {
    await writeSessionPhoneMismatch(kv, link.sessionId, link);
    return htmlPage(
      "手机号错",
      "<h1 class='err'>手机号错！</h1><p>请回到电脑端核对手机号与邮箱后重新扫码。</p>",
      403
    );
  }

  let sessionData = {
    scanned: true,
    emailLoginConfirmed: true,
    emailLoginPhoneMismatch: false,
    email: link.email || "",
    phone: normalizePhoneDigits(link.phone) || link.phone || "",
    username: link.username || "",
    confirmedAt: Date.now(),
  };
  try {
    const prev = await kv.get(link.sessionId);
    if (prev) {
      const j = JSON.parse(prev);
      if (j && typeof j === "object") {
        sessionData = {
          ...j,
          ...sessionData,
          emailLoginPending: false,
          emailLoginPhoneMismatch: false,
        };
      }
    }
  } catch (e) {}

  await kv.put(link.sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });

  return htmlPage(
    "登录已确认",
    "<h1 class='ok'>登录已确认</h1><p>可以关闭本页，回到电脑端继续。电脑上的登录窗口将自动完成登录。</p>"
  );
}
