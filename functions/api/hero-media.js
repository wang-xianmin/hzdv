/**
 * GET /api/hero-media?key=hero/xxx.mp4
 * 从 R2 读取首页背景媒体（完整 Range / Content-Length，保证视频可连续播放）。
 */

import { pickR2Binding } from "../lib/cloudflare-bindings.js";
import { normalizeHeroR2Key } from "../lib/hero-background-d1.js";

function guessContentType(key) {
  const lower = String(key || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function rangeEnd(range, size) {
  if (!range) return size - 1;
  if (typeof range.end === "number") return range.end;
  if (typeof range.offset === "number" && typeof range.length === "number") {
    return range.offset + range.length - 1;
  }
  return size - 1;
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
    const hasRange = request.headers.has("range");
    object = await r2.get(key, hasRange ? { range: request.headers } : undefined);
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
  // 同源 video 元素需要可发现长度，才能继续缓冲/播放
  headers.set("Content-Disposition", "inline");

  const size = typeof object.size === "number" ? object.size : null;
  let status = 200;

  if (object.range && size != null) {
    const offset = typeof object.range.offset === "number" ? object.range.offset : 0;
    const end = rangeEnd(object.range, size);
    const length = Math.max(0, end - offset + 1);
    headers.set("Content-Range", `bytes ${offset}-${end}/${size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else if (size != null) {
    headers.set("Content-Length", String(size));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}
