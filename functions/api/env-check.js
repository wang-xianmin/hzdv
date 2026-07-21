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
  return jsonResponse({
    success: true,
    has_my_kv: !!pickKvBinding(env),
    has_avatars_db: !!pickD1Binding(env),
    has_avatars_r2: !!pickR2Binding(env),
    d1_binding_names: ["DV_D1", "AVATARS_DB", "D1", "DB", "MY_DB", "avatar_db"],
    r2_binding_names: ["R2", "AVATARS_R2", "MY_R2", "avatar_r2", "BUCKET"],
    timestamp: Date.now(),
  });
}
