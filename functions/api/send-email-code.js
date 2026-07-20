/**
 * POST /api/send-email-code
 * Body: { email, code, is_auth? }
 *
 * 生产（Cloudflare Pages）：配置 RESEND_API_KEY + MAIL_FROM（如 noreply@hobby-era.com），
 * 在 Resend 控制台验证域名 hobby-era.com 后发送真实邮件。
 * 未配置 RESEND_API_KEY 时返回 503，便于发现未接邮件服务。
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sendViaResend({ apiKey, fromAddr, to, subject, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddr,
      to: [to],
      subject,
      text,
    }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
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
  const code = String(body.code || "").trim();
  if (!email || !code) {
    return jsonResponse({ error: "Missing email or code" }, 400);
  }
  const isAuth = body.is_auth === true;
  const subjectWord = isAuth ? "授权码" : "验证码";
  const subjectLine = subjectWord;
  const textBody = `您的${subjectWord}是: ${code}。请在3分钟内输入。`;

  const apiKey = (env.RESEND_API_KEY || "").trim();
  const fromAddr = (env.MAIL_FROM || "noreply@hobby-era.com").trim();

  if (!apiKey) {
    return jsonResponse(
      {
        success: false,
        error:
          "邮件服务未配置：请在 Cloudflare Pages 环境变量中设置 RESEND_API_KEY，并设置 MAIL_FROM（如 noreply@hobby-era.com）。说明见仓库 docs/email-verification.md",
      },
      503
    );
  }

  const { ok, status, data } = await sendViaResend({
    apiKey,
    fromAddr,
    to: email,
    subject: subjectLine,
    text: textBody,
  });

  if (!ok) {
    const msg =
      (data && (data.message || data.name)) ||
      `Resend HTTP ${status}`;
    console.error("[send-email-code] Resend error:", status, data);
    return jsonResponse({ success: false, error: String(msg) }, status >= 400 && status < 600 ? status : 502);
  }

  return jsonResponse({
    success: true,
    message: `${subjectWord}已发送到您的邮箱`,
  });
}
