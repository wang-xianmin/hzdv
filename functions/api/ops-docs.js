/**
 * 运维文档库
 *
 * GET    /api/ops-docs?phone=                 列表
 * POST   multipart: phone, title?, file       上传
 * DELETE JSON { phone, id }                   删除（发布人或超管/技术员）
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { pickD1Binding, pickR2Binding } from "../lib/cloudflare-bindings.js";
import {
  assertHeroOpsAccess,
  opsAuthErrorResponse,
} from "../lib/ops-auth.js";
import {
  buildOpsDocUploadKey,
  deleteOpsDocument,
  getOpsDocument,
  guessOpsDocContentType,
  insertOpsDocument,
  isAllowedOpsDocName,
  listOpsDocuments,
  normalizeOpsDocR2Key,
  opsDocsMaxBytes,
} from "../lib/ops-docs-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function phoneFromUrl(request) {
  return new URL(request.url).searchParams.get("phone") || "";
}

function isOpsFull(user) {
  return !!(user && (user.typeMask & 0x03) !== 0);
}

function publisherNameFromUser(user) {
  const v = (user && user.value) || {};
  return String(v.name || v.username || v.nick || "").trim().slice(0, 80);
}

export async function onRequest(context) {
  const { request, env } = context;
  const d1 = pickD1Binding(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }

  try {
    await ensureAllD1Tables(d1);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 500);
  }

  if (request.method === "GET") {
    try {
      await assertHeroOpsAccess(env, phoneFromUrl(request));
      const items = await listOpsDocuments(d1, { limit: 100 });
      return jsonResponse({ success: true, items });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "DELETE") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    }
    try {
      const user = await assertHeroOpsAccess(env, body.phone || "");
      const id = String(body.id || "").trim();
      if (!id) {
        return jsonResponse({ success: false, error: "缺少 id" }, 400);
      }
      const doc = await getOpsDocument(d1, id);
      if (!doc) {
        return jsonResponse({ success: false, error: "文档不存在" }, 404);
      }
      const canDelete =
        isOpsFull(user) ||
        String(doc.publisher_phone) === String(user.phone);
      if (!canDelete) {
        return jsonResponse(
          { success: false, error: "仅发布人或超管/技术员可删除" },
          403
        );
      }

      const r2 = pickR2Binding(env);
      const key = normalizeOpsDocR2Key(doc.r2_key);
      if (r2 && key) {
        try {
          await r2.delete(key);
        } catch (eDel) {
          console.warn("[ops-docs] R2 delete failed", key, eDel);
        }
      }
      await deleteOpsDocument(d1, id);
      return jsonResponse({ success: true, id });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "POST") {
    const contentType = String(request.headers.get("content-type") || "");
    if (!contentType.includes("multipart/form-data")) {
      return jsonResponse(
        { success: false, error: "请使用 multipart 上传" },
        400
      );
    }

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid form" }, 400);
    }

    try {
      const phone = String(form.get("phone") || "").trim();
      const user = await assertHeroOpsAccess(env, phone);
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") {
        return jsonResponse({ success: false, error: "缺少 file" }, 400);
      }
      const originalName = sanitizeIncomingName(
        file.name || form.get("filename") || "document.pdf"
      );
      if (!isAllowedOpsDocName(originalName)) {
        return jsonResponse(
          {
            success: false,
            error:
              "不支持的文件类型（允许 pdf/doc/docx/xls/xlsx/ppt/pptx/txt/md/csv 等）",
          },
          400
        );
      }

      const buf = await file.arrayBuffer();
      const size = buf.byteLength || 0;
      if (!size) {
        return jsonResponse({ success: false, error: "空文件" }, 400);
      }
      if (size > opsDocsMaxBytes()) {
        return jsonResponse(
          {
            success: false,
            error: "文件过大（上限 " + Math.floor(opsDocsMaxBytes() / (1024 * 1024)) + "MB）",
          },
          400
        );
      }

      const r2 = pickR2Binding(env);
      if (!r2) {
        return jsonResponse({ success: false, error: "R2 not configured" }, 500);
      }

      let title = String(form.get("title") || "").trim();
      if (!title) {
        title = originalName.replace(/\.[^.]+$/, "") || originalName;
      }
      title = title.slice(0, 200);

      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID().replace(/-/g, "")
          : "doc" + Date.now();
      const r2Key = buildOpsDocUploadKey(id, originalName);
      const ct = guessOpsDocContentType(
        originalName,
        file.type || "application/octet-stream"
      );

      await r2.put(r2Key, buf, {
        httpMetadata: {
          contentType: ct,
          contentDisposition:
            'attachment; filename="' +
            originalName.replace(/"/g, "") +
            '"',
        },
        customMetadata: {
          title,
          publisher: user.phone,
        },
      });

      const doc = await insertOpsDocument(d1, {
        id,
        title,
        original_name: originalName,
        content_type: ct,
        size_bytes: size,
        r2_key: r2Key,
        publisher_phone: user.phone,
        publisher_name: publisherNameFromUser(user),
      });

      return jsonResponse({ success: true, item: doc });
    } catch (e) {
      if (e && e.status) return opsAuthErrorResponse(e);
      return jsonResponse({ success: false, error: String(e.message || e) }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}

function sanitizeIncomingName(name) {
  return String(name || "file")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim()
    .slice(0, 180) || "file";
}
