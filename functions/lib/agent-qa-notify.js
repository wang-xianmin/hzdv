/**
 * 企业相关问答落库后邮件通知。
 *
 * 收件人（合并去重）：
 * 1. 系统设置 agentQaNotifyEmails（运维可改，无需重新部署）
 * 2. 环境变量 AGENT_QA_NOTIFY_EMAILS
 *
 * 需已配置 RESEND_API_KEY + MAIL_FROM。无收件人或未配密钥时静默跳过。
 */

import {
  escapeHtml,
  mailConfigFromEnv,
  parseEmailList,
  sendViaResend,
} from "./resend-mail.js";

const SYSTEM_USER_ID = "__system__";

async function loadSystemNotifyEmails(d1) {
  if (!d1) return "";
  try {
    const row = await d1
      .prepare(
        "SELECT settings_json FROM user_settings WHERE user_id = ?"
      )
      .bind(SYSTEM_USER_ID)
      .first();
    if (!row || !row.settings_json) return "";
    const saved = JSON.parse(String(row.settings_json));
    if (!saved || typeof saved !== "object") return "";
    return String(saved.agentQaNotifyEmails || "");
  } catch (e) {
    return "";
  }
}

function resolveRecipients(env, settingsEmails) {
  const fromSettings = parseEmailList(settingsEmails);
  const fromEnv = parseEmailList(
    (env && (env.AGENT_QA_NOTIFY_EMAILS || env.AGENT_QA_NOTIFY_TO)) || ""
  );
  const seen = new Set();
  const out = [];
  const all = fromSettings.concat(fromEnv);
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "（未登录/未知）";
  if (d.length <= 4) return "****" + d;
  return d.slice(0, 3) + "****" + d.slice(-4);
}

function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

function buildBodies(row, siteOrigin) {
  const q = String((row && row.question) || "").trim();
  const reply = String((row && row.reply_text) || "").trim();
  const category = String((row && row.category) || "other");
  const mode = String((row && row.answer_mode) || "prose");
  const id = String((row && row.id) || "");
  const phone = maskPhone(row && row.user_phone);
  const when = row && row.created_at
    ? new Date(Number(row.created_at)).toISOString()
    : new Date().toISOString();
  const origin = String(siteOrigin || "").replace(/\/$/, "");
  const opsHint = origin
    ? `${origin}/ （系统运维 → 企业问答）`
    : "系统运维 → 企业问答";

  const text =
    `【HZDV 企业问答】新问题待审\n\n` +
    `时间：${when}\n` +
    `分类：${category}\n` +
    `模式：${mode}\n` +
    `用户：${phone}\n` +
    `记录 ID：${id}\n\n` +
    `问题：\n${clip(q, 2000)}\n\n` +
    `当前回复：\n${clip(reply, 3000) || "（空）"}\n\n` +
    `请到运维后台修订：${opsHint}\n`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:28px 24px;">
        <tr><td>
          <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#111;">企业问答 · 新问题待审</p>
          <p style="margin:0 0 18px;font-size:13px;color:#666;">${escapeHtml(when)} · ${escapeHtml(category)} · ${escapeHtml(mode)}</p>
          <p style="margin:0 0 6px;font-size:12px;color:#888;">用户 ${escapeHtml(phone)} · ID ${escapeHtml(id)}</p>
          <p style="margin:16px 0 6px;font-size:13px;font-weight:600;color:#333;">问题</p>
          <pre style="margin:0 0 16px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.5;color:#111;background:#f8f8f9;padding:12px;border-radius:8px;">${escapeHtml(clip(q, 2000))}</pre>
          <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#333;">当前回复</p>
          <pre style="margin:0 0 20px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;color:#444;background:#f8f8f9;padding:12px;border-radius:8px;">${escapeHtml(clip(reply, 3000) || "（空）")}</pre>
          <p style="margin:0;font-size:12px;color:#888;">请到 ${escapeHtml(opsHint)} 审核修订。</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const subject = `[HZDV 企业问答] ${clip(q, 48) || "新问题"}`;
  return { subject, text, html };
}

/**
 * 落库成功后调用；失败只打日志，不抛错。
 * @returns {Promise<{ skipped?: boolean, reason?: string, sent?: number, failed?: number }>}
 */
export async function notifyEnterpriseQaEmails(env, d1, row, opts) {
  opts = opts || {};
  const mail = mailConfigFromEnv(env);
  if (!mail.apiKey) {
    return { skipped: true, reason: "no_resend_key" };
  }

  const settingsEmails = await loadSystemNotifyEmails(d1);
  const recipients = resolveRecipients(env, settingsEmails);
  if (!recipients.length) {
    return { skipped: true, reason: "no_recipients" };
  }

  const { subject, text, html } = buildBodies(row, opts.siteOrigin);
  let sent = 0;
  let failed = 0;

  // Resend 支持一次多人；失败时再逐个重试，避免一人坏地址拖垮全体
  const bulk = await sendViaResend({
    apiKey: mail.apiKey,
    fromAddr: mail.fromAddr,
    to: recipients,
    subject,
    text,
    html,
  });
  if (bulk.ok) {
    return { sent: recipients.length, failed: 0 };
  }

  for (let i = 0; i < recipients.length; i++) {
    try {
      const one = await sendViaResend({
        apiKey: mail.apiKey,
        fromAddr: mail.fromAddr,
        to: recipients[i],
        subject,
        text,
        html,
      });
      if (one.ok) sent += 1;
      else {
        failed += 1;
        console.error(
          "[agent-qa-notify] send failed",
          recipients[i],
          one.status,
          one.data
        );
      }
    } catch (e) {
      failed += 1;
      console.error("[agent-qa-notify] send error", recipients[i], e);
    }
  }
  return { sent, failed, bulkStatus: bulk.status };
}
