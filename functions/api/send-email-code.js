/**
 * POST /api/send-email-code
 *
 * 模式 A（魔法链接，推荐）：
 *   { email, phone?, username?, sessionId, siteOrigin?, mode: "magic_link" }
 *   → 发 HTML 邮件，按钮确认登录；点开后主站轮询 session 完成登录
 *
 * 模式 B（兼容旧验证码）：
 *   { email, code, is_auth? }
 *
 * 环境变量：RESEND_API_KEY、MAIL_FROM（如 HZDV <noreply@hzdv.net>）
 */

import { pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

async function sendViaResend({ apiKey, fromAddr, to, subject, text, html }) {
  const payload = {
    from: fromAddr,
    to: [to],
    subject,
    text,
  };
  if (html) payload.html = html;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

function buildMagicHtml({ confirmUrl, username }) {
  const name = username ? String(username) : "用户";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:32px 28px;">
        <tr><td>
          <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#111;">HZDV 登录确认</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#444;">
            你好，${name}。我们收到了你的登录请求。点击下面按钮即可在电脑端完成登录（链接约 10 分钟内有效）。
          </p>
          <p style="margin:0 0 28px;text-align:center;">
            <a href="${confirmUrl}"
               style="display:inline-block;background:#ff5a1f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:999px;">
              确认登录
            </a>
          </p>
          <p style="margin:0;font-size:12px;line-height:1.5;color:#888;">
            如果不是你本人操作，请忽略本邮件。若按钮无法点击，请复制此链接到浏览器打开：<br/>
            <span style="word-break:break-all;color:#555;">${confirmUrl}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = String(body.email || "").trim();
  if (!email) {
    return jsonResponse({ error: "Missing email" }, 400);
  }

  const apiKey = (env.RESEND_API_KEY || "").trim();
  const fromAddr = (env.MAIL_FROM || "HZDV <noreply@hzdv.net>").trim();

  if (!apiKey) {
    return jsonResponse(
      {
        success: false,
        error:
          "邮件服务未配置：请在 Cloudflare Pages 环境变量中设置 RESEND_API_KEY，并设置 MAIL_FROM（如 HZDV <noreply@hzdv.net>）。",
      },
      503
    );
  }

  const mode = String(body.mode || "").trim();
  const wantMagic =
    mode === "magic_link" ||
    body.magic_link === true ||
    (!!body.sessionId && !body.code);

  if (wantMagic) {
    const sessionId = String(body.sessionId || "").trim();
    const phone = String(body.phone || "").trim();
    const username = String(body.username || "").trim();
    if (!sessionId) {
      return jsonResponse({ error: "Missing sessionId" }, 400);
    }

    const kv = pickKvBinding(env);
    if (!kv) {
      return jsonResponse({ success: false, error: "Server KV not configured" }, 503);
    }

    const reqUrl = new URL(request.url);
    let origin = String(body.siteOrigin || body.origin || "").trim().replace(/\/+$/, "");
    if (!origin) {
      origin = (env.CF_PAGES_URL || env.SITE_URL || `${reqUrl.protocol}//${reqUrl.host}`).replace(
        /\/+$/,
        ""
      );
    }

    const token = randomToken();
    const payload = {
      sessionId,
      email,
      phone,
      username,
      createdAt: Date.now(),
    };
    await kv.put("elink:" + token, JSON.stringify(payload), { expirationTtl: 600 });

    let sessionData = {
      scanned: true,
      emailLoginPending: true,
      email,
      phone,
      username,
    };
    try {
      const prev = await kv.get(sessionId);
      if (prev) {
        const j = JSON.parse(prev);
        if (j && typeof j === "object") sessionData = { ...j, ...sessionData };
      }
    } catch (e) {}
    await kv.put(sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });

    const confirmUrl = `${origin}/api/email-login-confirm?token=${encodeURIComponent(token)}`;
    const textBody = `你好，${username || "用户"}。请打开以下链接确认登录（约 10 分钟内有效）：\n${confirmUrl}\n\n如非本人操作请忽略。`;
    const htmlBody = buildMagicHtml({ confirmUrl, username });

    const { ok, status, data } = await sendViaResend({
      apiKey,
      fromAddr,
      to: email,
      subject: "确认登录 HZDV",
      text: textBody,
      html: htmlBody,
    });

    if (!ok) {
      const msg = (data && (data.message || data.name)) || `Resend HTTP ${status}`;
      console.error("[send-email-code] Resend error:", status, data);
      return jsonResponse(
        { success: false, error: String(msg) },
        status >= 400 && status < 600 ? status : 502
      );
    }

    return jsonResponse({
      success: true,
      mode: "magic_link",
      message: "登录确认邮件已发送，请查收邮箱并点击按钮",
    });
  }

  // —— 旧验证码模式 ——
  const code = String(body.code || "").trim();
  if (!code) {
    return jsonResponse({ error: "Missing email or code" }, 400);
  }
  const isAuth = body.is_auth === true;
  const subjectWord = isAuth ? "授权码" : "验证码";
  const textBody = `您的${subjectWord}是: ${code}。请在3分钟内输入。`;

  const { ok, status, data } = await sendViaResend({
    apiKey,
    fromAddr,
    to: email,
    subject: subjectWord,
    text: textBody,
  });

  if (!ok) {
    const msg = (data && (data.message || data.name)) || `Resend HTTP ${status}`;
    console.error("[send-email-code] Resend error:", status, data);
    return jsonResponse(
      { success: false, error: String(msg) },
      status >= 400 && status < 600 ? status : 502
    );
  }

  return jsonResponse({
    success: true,
    message: `${subjectWord}已发送到您的邮箱`,
  });
}
