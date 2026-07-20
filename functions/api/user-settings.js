/**
 * GET /api/user-settings?user_id=xxx
 * PUT /api/user-settings  body: { user_id, settings: { snapshotTopBar, snapshotBottomDock } }
 *
 * 用户设置读写接口（key-value 结构，所有设置项存为一个 JSON）。
 * 调试阶段不鉴权，正式上线后仅超级用户可写。
 */

import { pickD1ForDebugRegistry } from "../lib/debug-issue-registry-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const DEFAULT_SETTINGS = {
  snapshotTopBar: 60,
  snapshotBottomDock: 50,
  snapInterval: 5,
  colonGaussianC: 22,
  binaryThreshold: 140,
};

function mergeSettings(saved) {
  if (!saved || typeof saved !== "object") return Object.assign({}, DEFAULT_SETTINGS);
  var out = {};
  for (var k in DEFAULT_SETTINGS) {
    if (DEFAULT_SETTINGS.hasOwnProperty(k)) {
      out[k] = saved.hasOwnProperty(k) ? saved[k] : DEFAULT_SETTINGS[k];
    }
  }
  return out;
}

export async function onRequest(context) {
  var { request, env } = context;
  var d1 = pickD1ForDebugRegistry(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }

  try {
    await d1.prepare(
      "CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)"
    ).run();
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
      var row = await d1.prepare("SELECT settings_json FROM user_settings WHERE user_id = ?").bind(userId).first();
      var saved = null;
      try { saved = row && row.settings_json ? JSON.parse(row.settings_json) : null; } catch (eP) { saved = null; }
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
      var row = await d1.prepare("SELECT settings_json FROM user_settings WHERE user_id = ?").bind(userId).first();
      var existing = null;
      try { existing = row && row.settings_json ? JSON.parse(row.settings_json) : null; } catch (eP) { existing = null; }
      var merged = mergeSettings(existing);
      for (var k in incoming) {
        if (incoming.hasOwnProperty(k) && DEFAULT_SETTINGS.hasOwnProperty(k)) {
          merged[k] = incoming[k];
        }
      }
      var jsonStr = JSON.stringify(merged);
      var now = Date.now();
      await d1.prepare("INSERT OR REPLACE INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)").bind(userId, jsonStr, now).run();
      return jsonResponse({ success: true, user_id: userId, settings: merged });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e && (e.message || e)) }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}
