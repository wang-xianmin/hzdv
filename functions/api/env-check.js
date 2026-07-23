/**
 * 运行时绑定自检（仅返回存在性，不返回敏感值）
 * GET /api/env-check
 */

import { pickKvBinding } from "../lib/kv-binding.js";
import { pickD1Binding, pickR2Binding } from "../lib/cloudflare-bindings.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }
  // 只返回键名，便于排查「仪表盘已设但 Functions 读不到」；不含任何值
  const env_keys = Object.keys(env || {})
    .filter((k) => k && k !== "ASSETS")
    .sort();

  return jsonResponse({
    success: true,
    has_my_kv: !!pickKvBinding(env),
    has_avatars_db: !!pickD1Binding(env),
    has_avatars_r2: !!pickR2Binding(env),
    has_ocr_service_url: !!(env.OCR_SERVICE_URL || env.OCR_URL),
    has_ocr_api_key: !!env.OCR_API_KEY,
    has_encryption_key: !!env.ENCRYPTION_KEY,
    has_mail_from: !!env.MAIL_FROM,
    env_keys,
    d1_binding_names: ["hzdvd1", "DV_D1", "AVATARS_DB", "D1", "DB", "MY_DB", "avatar_db"],
    r2_binding_names: ["R2", "AVATARS_R2", "MY_R2", "avatar_r2", "BUCKET"],
    timestamp: Date.now(),
  });
}
