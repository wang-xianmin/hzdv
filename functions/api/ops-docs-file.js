/**
 * GET /api/ops-docs-file?phone=&id=&disposition=inline|attachment
 * 发布栏：鉴权后从 R2 流式输出（PDF/文本可 inline 手机阅读）。
 * 权限：assertHeroOpsAccess（超管 | 技术员 | 内容审核主管 | 内容审核员）
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding, pickR2Binding } from "../lib/cloudflare-bindings.js";
import {
  assertHeroOpsAccess,
  opsAuthErrorResponse,
} from "../lib/ops-auth.js";
import {
  getOpsDocument,
  guessOpsDocContentType,
  normalizeOpsDocR2Key,
  opsDocPreferInline,
} from "../lib/ops-docs-d1.js";

function rangeEnd(range, size) {
  if (!range) return size - 1;
  if (typeof range.end === "number") return range.end;
  if (typeof range.offset === "number" && typeof range.length === "number") {
    return range.offset + range.length - 1;
  }
  return size - 1;
}

function asciiFileName(name) {
  return String(name || "document")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/"/g, "")
    .slice(0, 120) || "document";
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const phone = url.searchParams.get("phone") || "";
  const id = String(url.searchParams.get("id") || "").trim();
  const kind = String(url.searchParams.get("kind") || "file")
    .trim()
    .toLowerCase();
  let disposition = String(url.searchParams.get("disposition") || "")
    .trim()
    .toLowerCase();

  if (!id) {
    return new Response("Missing id", { status: 400 });
  }

  let user;
  try {
    user = await assertHeroOpsAccess(env, phone);
  } catch (e) {
    return opsAuthErrorResponse(e);
  }
  void user;

  const d1 = pickD1Binding(env);
  if (!d1) {
    return new Response("D1 not configured", { status: 503 });
  }
  try {
    await ensureAllD1Tables(d1);
  } catch (e) {
    return new Response(String(e.message || e), { status: 500 });
  }

  const doc = await getOpsDocument(d1, id);
  if (!doc) {
    return new Response("Not Found", { status: 404 });
  }

  const wantImage = kind === "image" || kind === "img" || kind === "thumb";
  const rawKey = wantImage ? doc.image_r2_key : doc.r2_key;
  const key = normalizeOpsDocR2Key(rawKey);
  if (!key || !key.startsWith("ops-docs/")) {
    return new Response(wantImage ? "No image" : "Invalid key", {
      status: 404,
    });
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

  const ct = wantImage
    ? guessOpsDocContentType(key, "image/jpeg")
    : doc.content_type ||
      guessOpsDocContentType(doc.original_name || doc.title);
  if (!disposition) {
    disposition = wantImage
      ? "inline"
      : opsDocPreferInline(ct, doc.original_name)
        ? "inline"
        : "attachment";
  }
  if (disposition !== "inline" && disposition !== "attachment") {
    disposition = "attachment";
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  headers.set("Content-Type", ct);
  headers.set("Cache-Control", "private, max-age=60");
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    disposition + '; filename="' + asciiFileName(doc.original_name || doc.title) + '"'
  );
  headers.set("X-Content-Type-Options", "nosniff");

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
