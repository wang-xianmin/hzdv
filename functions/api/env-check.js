/**
 * 运行时绑定自检（仅返回存在性，不返回敏感值）
 * GET /api/env-check
 */

import { pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hasKv(env) {
  return !!pickKvBinding(env);
}

function hasD1(env) {
  const cands = [env.AVATARS_DB, env.D1, env.DB, env.MY_DB, env.avatar_db];
  return cands.some((db) => db && typeof db.prepare === "function");
}

function hasR2(env) {
  const cands = [env.AVATARS_R2, env.R2, env.MY_R2, env.avatar_r2, env.BUCKET];
  return cands.some((b) => b && typeof b.get === "function");
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }
  return jsonResponse({
    success: true,
    has_my_kv: hasKv(env),
    has_avatars_db: hasD1(env),
    has_avatars_r2: hasR2(env),
    timestamp: Date.now(),
  });
}

