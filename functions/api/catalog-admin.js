/**
 * 产品目录管理（运维）
 * GET    /api/catalog-admin?phone=
 * POST   JSON { phone, action: "create", ...fields }
 * PATCH  JSON { phone, id, ...fields } | { phone, action: "set_cover", id, r2_key }
 * DELETE JSON { phone, id } | { phone, action: "delete_media", media_id }
 * POST   multipart: phone, item_id, file [, caption]
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { assertCatalogOpsAccess, opsAuthErrorResponse } from "../lib/ops-auth.js";
import { pickD1Binding, pickR2Binding } from "../lib/cloudflare-bindings.js";
import {
  addCatalogMedia,
  buildCatalogUploadKey,
  createCatalogItem,
  deleteCatalogItem,
  deleteCatalogMedia,
  getCatalogItem,
  guessCatalogContentType,
  guessCatalogMediaType,
  listCatalogItems,
  normalizeCatalogR2Key,
  setCatalogCover,
  updateCatalogItem,
} from "../lib/catalog-d1.js";
import {
  listCatalogSynonyms,
  saveCatalogSynonyms,
} from "../lib/catalog-synonyms.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function phoneFromUrl(request) {
  return new URL(request.url).searchParams.get("phone") || "";
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
      await assertCatalogOpsAccess(env, phoneFromUrl(request));
      const view = new URL(request.url).searchParams.get("view") || "";
      if (view === "synonyms") {
        const synonyms = await listCatalogSynonyms(d1);
        return jsonResponse({ success: true, synonyms });
      }
      const items = await listCatalogItems(d1, { includeInactive: true });
      return jsonResponse({ success: true, items });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    try {
      await assertCatalogOpsAccess(env, body.phone);
      if (body.action === "save_synonyms") {
        const synonyms = await saveCatalogSynonyms(d1, body.synonyms || body.rows);
        return jsonResponse({
          success: true,
          synonyms,
          hint: "同义词已保存。若希望向量检索立即吃到新说法，请点「重建向量索引」。",
        });
      }
      if (body.action === "set_cover") {
        const item = await setCatalogCover(d1, body.id, body.r2_key);
        if (!item) {
          return jsonResponse({ success: false, error: "条目不存在" }, 404);
        }
        return jsonResponse({ success: true, item });
      }
      if (!body.id) {
        return jsonResponse({ success: false, error: "缺少 id" }, 400);
      }
      const item = await updateCatalogItem(d1, body.id, body);
      if (!item) {
        return jsonResponse({ success: false, error: "条目不存在" }, 404);
      }
      return jsonResponse({ success: true, item });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "DELETE") {
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    try {
      await assertCatalogOpsAccess(env, body.phone);
      const r2 = pickR2Binding(env);
      if (body.action === "delete_media" || body.media_id) {
        const result = await deleteCatalogMedia(d1, r2, body.media_id);
        if (result.missing) {
          return jsonResponse({ success: false, error: "媒体不存在" }, 404);
        }
        const item = result.item_id
          ? await getCatalogItem(d1, result.item_id)
          : null;
        return jsonResponse({ success: true, item });
      }
      if (!body.id) {
        return jsonResponse({ success: false, error: "缺少 id" }, 400);
      }
      const result = await deleteCatalogItem(d1, r2, body.id);
      if (result.missing) {
        return jsonResponse({ success: false, error: "条目不存在" }, 404);
      }
      return jsonResponse({ success: true });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const contentType = String(request.headers.get("content-type") || "");
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const phone = form.get("phone");
      await assertCatalogOpsAccess(env, phone);
      const itemId = String(form.get("item_id") || "").trim();
      if (!itemId) {
        return jsonResponse({ success: false, error: "缺少 item_id" }, 400);
      }
      const item = await getCatalogItem(d1, itemId);
      if (!item) {
        return jsonResponse({ success: false, error: "条目不存在" }, 404);
      }
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") {
        return jsonResponse({ success: false, error: "缺少 file" }, 400);
      }
      const r2 = pickR2Binding(env);
      if (!r2) {
        return jsonResponse({ success: false, error: "R2 not configured" }, 500);
      }
      const filename = file.name || "upload.bin";
      const buf = await file.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return jsonResponse({ success: false, error: "上传文件为空" }, 400);
      }
      const r2Key = buildCatalogUploadKey(filename);
      const ct =
        (file.type && String(file.type).trim()) ||
        guessCatalogContentType(filename);
      await r2.put(r2Key, buf, { httpMetadata: { contentType: ct } });
      const mediaType = guessCatalogMediaType(file.type || filename);
      const media = await addCatalogMedia(d1, itemId, {
        r2_key: r2Key,
        media_type: mediaType,
        caption: String(form.get("caption") || ""),
      });
      const updated = await getCatalogItem(d1, itemId);
      return jsonResponse({ success: true, media, item: updated });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  const body = await readJsonBody(request);
  if (!body) {
    return jsonResponse(
      { success: false, error: "Expected multipart/form-data or JSON" },
      400
    );
  }
  try {
    await assertCatalogOpsAccess(env, body.phone);
    if (body.action === "create" || !body.action) {
      const item = await createCatalogItem(d1, body);
      return jsonResponse({ success: true, item });
    }
    return jsonResponse({ success: false, error: "未知 action" }, 400);
  } catch (e) {
    return opsAuthErrorResponse(e);
  }
}
