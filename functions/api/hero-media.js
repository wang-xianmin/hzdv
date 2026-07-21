/**
 * GET /api/hero-media?key=hero/xxx.mp4
 * 从 R2 读取首页背景媒体（支持 Range，便于视频流式播放）。
 */

import { pickR2Binding } from "../lib/cloudflare-bindings.js";
import { normalizeHeroR2Key } from "../lib/hero-background-d1.js";

function guessContentType(key) {
  const lower = String(key || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const key = normalizeHeroR2Key(url.searchParams.get("key"));
  if (!key) {
    return new Response("Missing or invalid key", { status: 400 });
  }

  const r2 = pickR2Binding(env);
  if (!r2) {
    return new Response("R2 not configured", { status: 503 });
  }

  let object;
  try {
    object = await r2.get(key, { range: request });
  } catch (e) {
    return new Response(String((e && e.message) || e || "R2 read failed"), {
      status: 500,
    });
  }

  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", guessContentType(key));
  }
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("Accept-Ranges", "bytes");

  const status = object.range ? 206 : 200;
  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}
