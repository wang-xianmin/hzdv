/**
 * GET /api/user-settings?user_id=xxx
 * PUT /api/user-settings  body: { user_id, settings: { ... } }
 *
 * 系统参数：约定 user_id = "__system__"（全局一份 JSON）。
 * 调试阶段不鉴权，正式上线后仅超级用户可写。
 */

import { pickD1ForDebugRegistry } from "../lib/debug-issue-registry-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 与 lib/user/system-settings-modal.js DEFAULTS 保持一致 */
const DEFAULT_SETTINGS = {
  ocrPreviewChars: 4500,
  ocrTextMaxPdf: 14000,
  ocrTextMaxImage: 6000,
  ocrVisionMaxPages: 6,
  pdfVisionMaxPages: 6,
  pdfRenderDpi: 120,
  /** 1=聊天区显示 OCR 开发者预览；0=不展开 */
  ocrShowDevPreview: 1,
  /** 1=OCR 随下一条消息送 LLM；0=不送 */
  ocrSendToLlm: 1,
  /** 0整段离线 SenseVoice / 1客户端VAD+SenseVoice / 2服务端 SenseVoice+VAD 模拟流式 */
  asrMicMode: 1,
};

function mergeSettings(saved) {
  if (!saved || typeof saved !== "object") return Object.assign({}, DEFAULT_SETTINGS);
  var out = {};
  for (var k in DEFAULT_SETTINGS) {
    if (DEFAULT_SETTINGS.hasOwnProperty(k)) {
      out[k] = saved.hasOwnProperty(k) ? saved[k] : DEFAULT_SETTINGS[k];
    }
  }
  if (saved.asrMicMode == null && saved.asrVadLive != null) {
    var legacy = parseInt(saved.asrVadLive, 10);
    out.asrMicMode = legacy === 0 ? 0 : 1;
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function sanitizeIncoming(incoming) {
  var base = mergeSettings(null);
  if (!incoming || typeof incoming !== "object") return base;
  return {
    ocrPreviewChars: clampInt(
      incoming.ocrPreviewChars,
      500,
      200000,
      base.ocrPreviewChars
    ),
    ocrTextMaxPdf: clampInt(incoming.ocrTextMaxPdf, 1000, 200000, base.ocrTextMaxPdf),
    ocrTextMaxImage: clampInt(
      incoming.ocrTextMaxImage,
      500,
      100000,
      base.ocrTextMaxImage
    ),
    ocrVisionMaxPages: clampInt(
      incoming.ocrVisionMaxPages,
      1,
      20,
      base.ocrVisionMaxPages
    ),
    pdfVisionMaxPages: clampInt(
      incoming.pdfVisionMaxPages,
      1,
      20,
      base.pdfVisionMaxPages
    ),
    pdfRenderDpi: clampInt(incoming.pdfRenderDpi, 72, 200, base.pdfRenderDpi),
    ocrShowDevPreview: clampInt(
      incoming.ocrShowDevPreview,
      0,
      1,
      base.ocrShowDevPreview
    ),
    ocrSendToLlm: clampInt(incoming.ocrSendToLlm, 0, 1, base.ocrSendToLlm),
    asrMicMode: clampInt(
      incoming.asrMicMode != null
        ? incoming.asrMicMode
        : incoming.asrVadLive === 0 || incoming.asrVadLive === "0"
          ? 0
          : base.asrMicMode,
      0,
      2,
      base.asrMicMode
    ),
  };
}

export async function onRequest(context) {
  var { request, env } = context;
  var d1 = pickD1ForDebugRegistry(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }

  try {
    await d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)"
      )
      .run();
  } catch (e) {
    return jsonResponse({ success: false, error: String(e && (e.message || e)) }, 500);
  }

  if (request.method === "GET") {
    var url = new URL(request.url);
    var userId = (url.searchParams.get("user_id") || "").trim();
    if (!userId) {
      return jsonResponse({ success: false, error: "Missing user_id" }, 400);
    }

    try {
      var row = await d1
        .prepare("SELECT settings_json FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
      var saved = null;
      try {
        saved = row && row.settings_json ? JSON.parse(row.settings_json) : null;
      } catch (eP) {
        saved = null;
      }
      var settings = mergeSettings(saved);
      return jsonResponse({ success: true, user_id: userId, settings: settings });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e && (e.message || e)) }, 500);
    }
  }

  if (request.method === "PUT") {
    try {
      var body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    var userId = String(body && body.user_id ? body.user_id : "").trim();
    if (!userId) {
      return jsonResponse({ success: false, error: "Missing user_id" }, 400);
    }
    var incoming = body && body.settings && typeof body.settings === "object" ? body.settings : {};

    try {
      var row = await d1
        .prepare("SELECT settings_json FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
      var existing = null;
      try {
        existing = row && row.settings_json ? JSON.parse(row.settings_json) : null;
      } catch (eP) {
        existing = null;
      }
      var merged = mergeSettings(existing);
      var clean = sanitizeIncoming(incoming);
      for (var k in clean) {
        if (clean.hasOwnProperty(k) && DEFAULT_SETTINGS.hasOwnProperty(k)) {
          merged[k] = clean[k];
        }
      }
      var jsonStr = JSON.stringify(merged);
      var now = Date.now();
      await d1
        .prepare(
          "INSERT OR REPLACE INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)"
        )
        .bind(userId, jsonStr, now)
        .run();
      return jsonResponse({ success: true, user_id: userId, settings: merged });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e && (e.message || e)) }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}
