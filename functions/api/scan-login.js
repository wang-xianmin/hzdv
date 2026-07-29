import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 扫码登录 API：GET /api/scan-login?sessionId=xxx
 * POST：写入/合并会话（手机扫码、电脑端回写 pcStatus 等）。
 * 当手机扫码写入 scanned:true 时，若会话已有 phone+email，服务端直接发信。
 */
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function getQuerySessionId(url) {
  const p = url.searchParams;
  return (
    p.get("sessionId") ||
    p.get("sessionid") ||
    p.get("key") ||
    p.get("Key")
  );
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = getQuerySessionId(url);

  try {
    const kv = pickKvBinding(env);
    if (!kv) {
      return jsonResponse(
        {
          exists: false,
          msg: "Server KV not configured",
          hint: kvBindingHint(),
        },
        503
      );
    }

    if (request.method === "GET") {
      if (!sessionId) {
        return jsonResponse({ exists: false, msg: "Missing sessionId" }, 400);
      }
      const value = await kv.get(sessionId);

      let data = null;
      if (value) {
        try {
          data = JSON.parse(value);
        } catch {
          data = null;
        }
      }
      return jsonResponse(
        {
          exists: !!value,
          data,
        },
        200,
        {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
        }
      );
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        const sid = body.sessionId || body.key;
        if (!sid || !body.data || typeof body.data !== "object") {
          return jsonResponse(
            { success: false, msg: "Data incomplete" },
            400
          );
        }

        let prev = {};
        try {
          const raw = await kv.get(sid);
          if (raw) {
            const j = JSON.parse(raw);
            if (j && typeof j === "object") prev = j;
          }
        } catch (e) {
          prev = {};
        }

        const incoming = body.data;
        const data = {
          ...prev,
          ...incoming,
          scanned:
            incoming.scanned !== undefined
              ? !!incoming.scanned
              : !!prev.scanned,
          mobileConfirmed:
            incoming.mobileConfirmed !== undefined
              ? !!incoming.mobileConfirmed
              : !!prev.mobileConfirmed,
        };

        await kv.put(sid, JSON.stringify(data), {
          expirationTtl: 600,
        });

        // 手机扫码 + 会话已有 phone/email + 尚未处理 → 服务端直接发信
        if (
          data.scanned === true &&
          incoming.scanned === true &&
          !data.pcStatus &&
          data.phone &&
          data.email &&
          isValidEmail(data.email)
        ) {
          // 直接在服务端发信（复用 send-email-code 的逻辑）
          const sendResult = await triggerMagicLink(context, kv, sid, data);
          return jsonResponse({ success: true, data: sendResult.data, triggered: true });
        }

        return jsonResponse({ success: true, data });
      } catch (err) {
        return jsonResponse({ success: false, msg: "Invalid JSON" }, 400);
      }
    }

    return jsonResponse({ error: "Method Not Allowed" }, 405);
  } catch (err) {
    console.error("scan-login:", err);
    return jsonResponse(
      { exists: false, success: false, msg: String(err.message || err) },
      500
    );
  }
}

/**
 * 服务端直接触发 magic link 发信。
 * 复制 send-email-code 的核心逻辑，在 scan-login POST 内联执行。
 */
async function triggerMagicLink(context, kv, sessionId, sessionData) {
  const { env, request } = context;

  const email = String(sessionData.email || "").trim();
  const phone = String(sessionData.phone || "").trim();
  const username = String(sessionData.username || "").trim();
  const uiLang = String(sessionData.lang || "zh").toLowerCase().startsWith("en") ? "en" : "zh";

  const apiKey = env.RESEND_API_KEY || "";
  const fromAddr = env.MAIL_FROM || "HZDV <noreply@hzdv.net>";

  if (!apiKey) {
    const failData = {
      ...sessionData,
      pcStatus: "reject_send",
      rejectMsgZh: "邮件服务未配置",
      rejectMsgEn: "Mail service not configured",
      awaitingPc: false,
    };
    await kv.put(sessionId, JSON.stringify(failData), { expirationTtl: 600 });
    return { data: failData };
  }

  // 生成 token
  const token = crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

  const payload = {
    sessionId,
    email,
    phone,
    username,
    lang: uiLang,
    createdAt: Date.now(),
  };
  await kv.put("elink:" + token, JSON.stringify(payload), { expirationTtl: 600 });

  const reqUrl = new URL(request.url);
  let origin = String(sessionData.siteOrigin || "").trim().replace(/\/+$/, "");
  if (!origin) {
    origin = (
      env.CF_PAGES_URL ||
      env.SITE_URL ||
      `${reqUrl.protocol}//${reqUrl.host}`
    ).replace(/\/+$/, "");
  }

  const confirmUrl = `${origin}/api/email-login-confirm?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(uiLang)}`;

  const textBody =
    uiLang === "en"
      ? `Hi, ${username || "there"}. Open this link, then click "Confirm sign-in" on the page (valid for about 10 minutes):\n${confirmUrl}\n\nIf this wasn't you, ignore this email.`
      : `你好，${username || "用户"}。请打开以下链接，在页面中再次点击「确认登录」（约 10 分钟内有效）：\n${confirmUrl}\n\n如非本人操作请忽略。`;

  const htmlBody = buildSimpleHtml(confirmUrl, username, uiLang);

  let sendOk = false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [email],
        subject: uiLang === "en" ? "Confirm sign-in to HZDV" : "确认登录 HZDV",
        text: textBody,
        html: htmlBody,
      }),
    });
    sendOk = res.ok;
    if (!sendOk) {
      console.error("[scan-login triggerMagicLink] Resend error:", res.status);
    }
  } catch (e) {
    console.error("[scan-login triggerMagicLink] fetch error:", e);
    sendOk = false;
  }

  let finalData;
  if (sendOk) {
    finalData = {
      ...sessionData,
      pcStatus: "ok",
      emailSent: true,
      emailLoginPending: true,
      awaitingPc: false,
    };
  } else {
    finalData = {
      ...sessionData,
      pcStatus: "reject_send",
      rejectMsgZh: "发送确认邮件失败，请回到电脑端重试",
      rejectMsgEn: "Failed to send confirmation email. Please retry on the computer.",
      awaitingPc: false,
    };
  }
  await kv.put(sessionId, JSON.stringify(finalData), { expirationTtl: 600 });
  return { data: finalData };
}

function buildSimpleHtml(confirmUrl, username, lang) {
  const name = username || (lang === "en" ? "there" : "用户");
  if (lang === "en") {
    return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px"><p>Hi ${name},</p><p>Click the button to confirm sign-in (valid ~10 min):</p><p style="margin:24px 0"><a href="${confirmUrl}" style="background:#2b8a3e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">Confirm sign-in</a></p><p style="font-size:12px;color:#666">If this wasn't you, ignore this email.</p></div>`;
  }
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px"><p>你好 ${name}，</p><p>请点击下方按钮确认登录（约 10 分钟内有效）：</p><p style="margin:24px 0"><a href="${confirmUrl}" style="background:#2b8a3e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">确认登录</a></p><p style="font-size:12px;color:#666">如非本人操作请忽略此邮件。</p></div>`;
}
