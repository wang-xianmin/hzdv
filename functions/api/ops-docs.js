/**
 * 发布栏（运维文档）
 *
 * GET    /api/ops-docs?phone=                 列表
 * POST   multipart:
 *   - 新建：phone, title?, file（文档或图片）
 *   - 给已有行挂图形：phone, id, action=image, file（图片）
 * PATCH  JSON { phone, id, title }            改标题/内容
 * DELETE JSON { phone, id }                   删除（发布人或超管/技术员）
 * 权限：assertHeroOpsAccess（超管 | 技术员 | 内容审核主管 | 内容审核员）
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
  isAllowedOpsImageName,
  listOpsDocuments,
  normalizeOpsDocR2Key,
  opsDocsMaxBytes,
  opsDocsMaxImageBytes,
  updateOpsDocumentFile,
  updateOpsDocumentImage,
  updateOpsDocumentTitle,
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

function canMutateDoc(user, doc) {
  if (!user || !doc) return false;
  if (isOpsFull(user)) return true;
  return String(doc.publisher_phone) === String(user.phone);
}

function sanitizeIncomingName(name) {
  return (
    String(name || "file")
      .replace(/[/\\?%*:|"<>]/g, "_")
      .trim()
      .slice(0, 180) || "file"
  );
}

async function putR2(r2, key, buf, contentType, fileName) {
  await r2.put(key, buf, {
    httpMetadata: {
      contentType,
      contentDisposition:
        'inline; filename="' + String(fileName || "file").replace(/"/g, "") + '"',
    },
  });
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

  if (request.method === "PATCH") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    }
    try {
      const user = await assertHeroOpsAccess(env, body.phone || "");
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse({ success: false, error: "缺少 id" }, 400);
      const doc = await getOpsDocument(d1, id);
      if (!doc) return jsonResponse({ success: false, error: "不存在" }, 404);
      if (!canMutateDoc(user, doc)) {
        return jsonResponse({ success: false, error: "无权修改" }, 403);
      }
      if (body.title != null) {
        const item = await updateOpsDocumentTitle(d1, id, body.title);
        return jsonResponse({ success: true, item });
      }
      return jsonResponse({ success: false, error: "无可更新字段" }, 400);
    } catch (e) {
      if (e && e.status) return opsAuthErrorResponse(e);
      return jsonResponse({ success: false, error: String(e.message || e) }, 500);
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
      if (!canMutateDoc(user, doc)) {
        return jsonResponse(
          { success: false, error: "仅发布人或超管/技术员可删除" },
          403
        );
      }

      const r2 = pickR2Binding(env);
      const keys = [
        normalizeOpsDocR2Key(doc.r2_key),
        normalizeOpsDocR2Key(doc.image_r2_key),
      ].filter(Boolean);
      if (r2) {
        for (let i = 0; i < keys.length; i++) {
          try {
            await r2.delete(keys[i]);
          } catch (eDel) {
            console.warn("[ops-docs] R2 delete failed", keys[i], eDel);
          }
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

    /* JSON：新建空行草稿 */
    if (contentType.includes("application/json")) {
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      }
      try {
        const user = await assertHeroOpsAccess(env, body.phone || "");
        const action = String(body.action || "").trim().toLowerCase();
        if (action !== "create_draft" && action !== "draft" && action !== "create") {
          return jsonResponse({ success: false, error: "未知 action" }, 400);
        }

        /* 已有「标题空且无图」的未完成行 → 禁止再新增 */
        const existing = await listOpsDocuments(d1, { limit: 100 });
        const blocked = existing.some(
          (row) =>
            !String(row.title || "").trim() &&
            !String(row.image_r2_key || "").trim() &&
            !String(row.r2_key || "").trim()
        );
        if (blocked) {
          return jsonResponse(
            {
              success: false,
              error: "请先填写标题、上传图片或挂上 PDF 后再新增",
              blocked: true,
            },
            409
          );
        }

        const doc = await insertOpsDocument(d1, {
          title: "",
          allow_empty_title: true,
          original_name: "",
          content_type: "application/octet-stream",
          size_bytes: 0,
          r2_key: "",
          image_r2_key: "",
          publisher_phone: user.phone,
          publisher_name: publisherNameFromUser(user),
        });
        return jsonResponse({ success: true, item: doc });
      } catch (e) {
        if (e && e.status) return opsAuthErrorResponse(e);
        return jsonResponse(
          { success: false, error: String(e.message || e) },
          500
        );
      }
    }

    if (!contentType.includes("multipart/form-data")) {
      return jsonResponse(
        { success: false, error: "请使用 multipart 上传或 JSON 新建" },
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
      const action = String(form.get("action") || "").trim().toLowerCase();
      const existingId = String(form.get("id") || "").trim();
      const asImageName = isAllowedOpsImageName(originalName);
      const asDocName = isAllowedOpsDocName(originalName);

      const r2 = pickR2Binding(env);
      if (!r2) {
        return jsonResponse({ success: false, error: "R2 not configured" }, 500);
      }

      const buf = await file.arrayBuffer();
      const size = buf.byteLength || 0;
      if (!size) {
        return jsonResponse({ success: false, error: "空文件" }, 400);
      }

      /* —— 给已有行挂 / 替换 图形或 PDF —— */
      if (existingId) {
        const doc = await getOpsDocument(d1, existingId);
        if (!doc) {
          return jsonResponse({ success: false, error: "文档不存在" }, 404);
        }
        if (!canMutateDoc(user, doc)) {
          return jsonResponse({ success: false, error: "无权修改" }, 403);
        }

        const wantImage =
          action === "image" || (asImageName && action !== "file");
        if (wantImage) {
          if (!asImageName) {
            return jsonResponse(
              { success: false, error: "图形仅支持 jpg/png/webp/gif 等图片" },
              400
            );
          }
          if (size > opsDocsMaxImageBytes()) {
            return jsonResponse(
              { success: false, error: "图片过大（上限 12MB）" },
              400
            );
          }
          const ct = guessOpsDocContentType(
            originalName,
            file.type || "image/jpeg"
          );
          const imgKey = buildOpsDocUploadKey(doc.id, originalName, "image");
          await putR2(r2, imgKey, buf, ct, originalName);
          const oldKey = normalizeOpsDocR2Key(doc.image_r2_key);
          const item = await updateOpsDocumentImage(d1, doc.id, imgKey);
          if (oldKey && oldKey !== imgKey) {
            try {
              await r2.delete(oldKey);
            } catch (e2) {}
          }
          return jsonResponse({ success: true, item });
        }

        if (!asDocName) {
          return jsonResponse(
            {
              success: false,
              error: "附件仅支持 pdf/doc/docx 等文档",
            },
            400
          );
        }
        if (size > opsDocsMaxBytes()) {
          return jsonResponse(
            {
              success: false,
              error:
                "文件过大（上限 " +
                Math.floor(opsDocsMaxBytes() / (1024 * 1024)) +
                "MB）",
            },
            400
          );
        }
        const ct = guessOpsDocContentType(
          originalName,
          file.type || "application/octet-stream"
        );
        const fileKey = buildOpsDocUploadKey(doc.id, originalName, "file");
        await putR2(r2, fileKey, buf, ct, originalName);
        const oldFile = normalizeOpsDocR2Key(doc.r2_key);
        const item = await updateOpsDocumentFile(d1, doc.id, {
          r2_key: fileKey,
          original_name: originalName,
          content_type: ct,
          size_bytes: size,
          title: String(form.get("title") || "").trim(),
        });
        if (oldFile && oldFile !== fileKey) {
          try {
            await r2.delete(oldFile);
          } catch (e3) {}
        }
        return jsonResponse({ success: true, item });
      }

      /* —— 新建一行 —— */
      const asImage = asImageName;
      const asDoc = asDocName;
      if (!asImage && !asDoc) {
        return jsonResponse(
          {
            success: false,
            error:
              "不支持的文件类型（文档 pdf/doc/docx… 或图片 jpg/png/webp…）",
          },
          400
        );
      }
      if (asImage && size > opsDocsMaxImageBytes()) {
        return jsonResponse(
          { success: false, error: "图片过大（上限 12MB）" },
          400
        );
      }
      if (!asImage && size > opsDocsMaxBytes()) {
        return jsonResponse(
          {
            success: false,
            error:
              "文件过大（上限 " +
              Math.floor(opsDocsMaxBytes() / (1024 * 1024)) +
              "MB）",
          },
          400
        );
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
      const ct = guessOpsDocContentType(
        originalName,
        file.type || "application/octet-stream"
      );

      let r2Key = "";
      let imageKey = "";
      if (asImage) {
        imageKey = buildOpsDocUploadKey(id, originalName, "image");
        await putR2(r2, imageKey, buf, ct, originalName);
      } else {
        r2Key = buildOpsDocUploadKey(id, originalName, "file");
        await putR2(r2, r2Key, buf, ct, originalName);
      }

      const doc = await insertOpsDocument(d1, {
        id,
        title,
        body_text: String(form.get("body_text") || form.get("body") || ""),
        original_name: asDoc ? originalName : asImage ? originalName : "",
        content_type: asDoc ? ct : asImage ? ct : "application/octet-stream",
        size_bytes: size,
        r2_key: r2Key,
        image_r2_key: imageKey,
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
