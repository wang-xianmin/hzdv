/**
 * Resend 发信公共封装（登录确认、企业问答通知等共用）。
 * 环境变量：RESEND_API_KEY、MAIL_FROM（如 HZDV <noreply@hzdv.net>）
 */

export function isValidEmailAddress(email) {
  const e = String(email || "").trim();
  if (!e || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** 解析逗号 / 分号 / 空白分隔的邮箱列表，去重保序 */
export function parseEmailList(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  const parts = text.split(/[,;\s]+/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const e = String(parts[i] || "").trim().toLowerCase();
    if (!e || !isValidEmailAddress(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

export function escapeHtml(s) {
  return String(s == null ? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @returns {Promise<{ ok: boolean, status: number, data: object }>}
 */
export async function sendViaResend({ apiKey, fromAddr, to, subject, text, html }) {
  const recipients = Array.isArray(to)
    ? to.filter((x) => isValidEmailAddress(x))
    : isValidEmailAddress(to)
      ? [String(to).trim()]
      : [];
  if (!recipients.length) {
    return { ok: false, status: 400, data: { error: "no recipients" } };
  }
  const key = String(apiKey || "").trim();
  const from = String(fromAddr || "").trim();
  if (!key || !from) {
    return { ok: false, status: 503, data: { error: "mail not configured" } };
  }

  const payload = {
    from,
    to: recipients,
    subject: String(subject || "").slice(0, 200),
    text: String(text || ""),
  };
  if (html) payload.html = html;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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

export function mailConfigFromEnv(env) {
  return {
    apiKey: String((env && env.RESEND_API_KEY) || "").trim(),
    fromAddr: String(
      (env && env.MAIL_FROM) || "HZDV <noreply@hzdv.net>"
    ).trim(),
  };
}
