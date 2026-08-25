import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 扫码登录 API：GET /api/scan-login?sessionId=xxx
 * POST：写入会话数据到 KV，TTL 300 秒。
 * 手机扫码若携带 phone+email，后台触发 magic-link 发信（不阻塞扫码响应）。
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

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

async function triggerMagicLinkFromScan(request, env, sid, data) {
  const phone = String((data && data.phone) || "").trim();
  const email = String((data && data.email) || "").trim();
  if (!sid || !phone || !email || !looksLikeEmail(email)) return;

  const origin = new URL(request.url).origin;
  const siteOrigin = String((data && data.siteOrigin) || origin).trim() || origin;
  const lang = String((data && data.lang) || "zh").trim() || "zh";

  try {
    const res = await fetch(`${origin}/api/send-email-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "magic_link",
        email,
        phone,
        sessionId: sid,
        siteOrigin,
        lang,
      }),
    });
    if (!res.ok) {
      console.warn("scan-login magic_link trigger HTTP", res.status);
    }
  } catch (err) {
    console.warn("scan-login magic_link trigger failed:", err);
  }
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
        if (!sid || !body.data) {
          return jsonResponse(
            { success: false, msg: "Data incomplete" },
            400
          );
        }

        // merge=true 时先读旧数据再合并（电脑端回写 pcStatus 用）
        if (body.merge === true) {
          let prev = {};
          try {
            const raw = await kv.get(sid);
            if (raw) {
              const j = JSON.parse(raw);
              if (j && typeof j === "object") prev = j;
            }
          } catch (e) {}
          const merged = { ...prev, ...body.data };
          await kv.put(sid, JSON.stringify(merged), { expirationTtl: 600 });
          return jsonResponse({ success: true });
        }

        // 手机扫码：读旧会话做幂等，避免 Safari 后台页重载重复发信
        const data = body.data && typeof body.data === "object" ? { ...body.data } : {};
        let prev = {};
        try {
          const raw = await kv.get(sid);
          if (raw) {
            const j = JSON.parse(raw);
            if (j && typeof j === "object") prev = j;
          }
        } catch (ePrev) {}

        const alreadyTriggered =
          !!prev.emailSent ||
          prev.pcStatus === "ok" ||
          (prev.emailLoginPending === true &&
            (prev.pcStatus === "processing" || prev.pcStatus === "ok"));

        const canTrigger =
          !alreadyTriggered &&
          data.scanned &&
          data.phone &&
          data.email &&
          looksLikeEmail(data.email);

        // 先标 processing，避免电脑端轮询抢先再发一封
        if (canTrigger && !data.pcStatus) {
          data.pcStatus = "processing";
          data.emailLoginPending = true;
        }

        // 重复 POST：保留已发信状态，勿覆盖成「未处理」
        const toStore = alreadyTriggered
          ? {
              ...prev,
              ...data,
              emailSent: prev.emailSent,
              pcStatus: prev.pcStatus || data.pcStatus,
              emailLoginPending:
                prev.emailLoginPending != null
                  ? prev.emailLoginPending
                  : data.emailLoginPending,
              magicLinkSkipDup: true,
              lastRescanAt: Date.now(),
            }
          : data;

        await kv.put(sid, JSON.stringify(toStore), {
          expirationTtl: 300,
        });

        if (canTrigger) {
          const job = triggerMagicLinkFromScan(request, env, sid, toStore);
          if (typeof context.waitUntil === "function") {
            context.waitUntil(job);
          } else {
            job.catch(function () {});
          }
        }

        return jsonResponse({
          success: true,
          alreadyTriggered: alreadyTriggered || undefined,
        });
      } catch {
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
