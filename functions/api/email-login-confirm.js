/**
 * GET /api/email-login-confirm?token=...
 * 用户点击邮件按钮后进入此页：校验 token，标记扫码会话已确认，电脑端轮询后完成登录。
 */

import { pickKvBinding, kvBindingHint } from "../lib/kv-binding.js";

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

  let sessionData = {
    scanned: true,
    emailLoginConfirmed: true,
    email: link.email || "",
    phone: link.phone || "",
    username: link.username || "",
    confirmedAt: Date.now(),
  };
  try {
    const prev = await kv.get(link.sessionId);
    if (prev) {
      const j = JSON.parse(prev);
      if (j && typeof j === "object") {
        sessionData = { ...j, ...sessionData, emailLoginPending: false };
      }
    }
  } catch (e) {}

  await kv.put(link.sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
  // 一次性链接
  await kv.delete("elink:" + token);

  return htmlPage(
    "登录已确认",
    "<h1 class='ok'>登录已确认</h1><p>可以关闭本页，回到电脑端继续。电脑上的登录窗口将自动完成登录。</p>"
  );
}
