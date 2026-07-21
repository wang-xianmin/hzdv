/**
 * 网站背景管理（运维）
 * GET    /api/hero-backgrounds-admin?phone=...
 * PUT    JSON { phone, config }
 * POST   multipart 新建: phone, file, [poster], [file_mobile], ...
 * POST   multipart 替换槽位: phone, id, slot=desktop|mobile, file, [poster]
 * PATCH  JSON { phone, id, ...fields }
 * DELETE JSON { phone, id }
 */

import { ensureAllD1Tables } from "../lib/d1-schema.js";
import { assertOpsAccess, opsAuthErrorResponse } from "../lib/ops-auth.js";
import { pickR2Binding } from "../lib/cloudflare-bindings.js";
import {
  buildHeroUploadKey,
  deleteHeroBackgroundItem,
  deleteHeroSlotR2Keys,
  getHeroBackgroundConfig,
  guessHeroContentType,
  guessHeroMediaType,
  insertHeroBackgroundItem,
  listAllHeroBackgroundItems,
  normalizeHeroR2Key,
  pickHeroD1,
  saveHeroBackgroundConfig,
  updateHeroBackgroundItem,
} from "../lib/hero-background-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
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

async function putR2File(r2, file, namePrefix) {
  const filename = (namePrefix || "") + (file.name || "upload.bin");
  const r2Key = buildHeroUploadKey(filename);
  await r2.put(r2Key, file.stream(), {
    httpMetadata: { contentType: guessHeroContentType(filename) },
  });
  return r2Key;
}

export async function onRequest(context) {
  const { request, env } = context;
  const d1 = pickHeroD1(env);
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
      await assertOpsAccess(env, phoneFromUrl(request));
      const config = await getHeroBackgroundConfig(d1);
      const items = await listAllHeroBackgroundItems(d1, env);
      return jsonResponse({ success: true, config, items });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    try {
      await assertOpsAccess(env, body.phone);
      const config = await saveHeroBackgroundConfig(d1, body.config || {});
      return jsonResponse({ success: true, config });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    const id = Number(body.id);
    if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
    try {
      await assertOpsAccess(env, body.phone);
      const item = await updateHeroBackgroundItem(d1, env, id, body);
      if (!item) return jsonResponse({ success: false, error: "Not found" }, 404);
      return jsonResponse({ success: true, item });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "DELETE") {
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    const id = Number(body.id);
    if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
    try {
      await assertOpsAccess(env, body.phone);
      const r2 = pickR2Binding(env);
      const ok = await deleteHeroBackgroundItem(d1, id, r2);
      return jsonResponse({ success: ok });
    } catch (e) {
      return opsAuthErrorResponse(e);
    }
  }

  if (request.method === "POST") {
    const r2 = pickR2Binding(env);
    if (!r2) return jsonResponse({ success: false, error: "R2 not configured" }, 503);
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return jsonResponse({ success: false, error: "Expected multipart/form-data" }, 400);
    }
    try {
      const form = await request.formData();
      const phone = form.get("phone");
      const file = form.get("file");
      const poster = form.get("poster");
      if (!file || typeof file === "string") {
        return jsonResponse({ success: false, error: "Missing file" }, 400);
      }
      const auth = await assertOpsAccess(env, phone);
      const filename = file.name || "upload.bin";
      const mediaType =
        String(form.get("media_type") || "").trim() || guessHeroMediaType(filename);
      const replaceId = Number(form.get("id") || 0);
      const slot = String(form.get("slot") || "").trim().toLowerCase();

      /** 替换已有条目的 desktop / mobile 槽位 */
      if (replaceId && (slot === "desktop" || slot === "mobile")) {
        const existing = await d1
          .prepare("SELECT * FROM hero_background_items WHERE id = ?")
          .bind(replaceId)
          .first();
        if (!existing) return jsonResponse({ success: false, error: "Not found" }, 404);
        await deleteHeroSlotR2Keys(r2, existing, slot);

        const r2Key = await putR2File(r2, file, slot === "mobile" ? "m-" : "");
        let posterKey = null;
        if (poster && typeof poster !== "string" && poster.name) {
          posterKey = await putR2File(
            r2,
            poster,
            slot === "mobile" ? "m-poster-" : "poster-"
          );
        }
        const patch =
          slot === "mobile"
            ? {
                media_type: mediaType,
                r2_key_mobile: r2Key,
                poster_r2_key_mobile: posterKey,
              }
            : {
                media_type: mediaType,
                r2_key: r2Key,
                poster_r2_key: posterKey,
              };
        const item = await updateHeroBackgroundItem(d1, env, replaceId, patch);
        if (!item) return jsonResponse({ success: false, error: "Not found" }, 404);
        return jsonResponse({
          success: true,
          item,
          replaced: true,
          slot,
          r2_key: normalizeHeroR2Key(r2Key),
        });
      }

      const r2Key = await putR2File(r2, file, "");
      let posterKey = null;
      if (poster && typeof poster !== "string" && poster.name) {
        posterKey = await putR2File(r2, poster, "poster-");
      }

      const fileMobile = form.get("file_mobile");
      let r2KeyMobile = null;
      if (fileMobile && typeof fileMobile !== "string" && fileMobile.name) {
        r2KeyMobile = await putR2File(r2, fileMobile, "m-");
      }

      const posterMobile = form.get("poster_mobile");
      let posterKeyMobile = null;
      if (posterMobile && typeof posterMobile !== "string" && posterMobile.name) {
        posterKeyMobile = await putR2File(r2, posterMobile, "m-poster-");
      }

      const item = await insertHeroBackgroundItem(d1, env, {
        media_type: mediaType,
        r2_key: r2Key,
        r2_key_mobile: r2KeyMobile,
        poster_r2_key: posterKey,
        poster_r2_key_mobile: posterKeyMobile,
        title: form.get("title"),
        subtitle: form.get("subtitle"),
        cta_label: form.get("cta_label"),
        cta_url: form.get("cta_url"),
        duration_ms: form.get("duration_ms"),
        created_by: auth.phone,
      });
      return jsonResponse({ success: true, item, r2_key: normalizeHeroR2Key(r2Key) });
    } catch (e) {
      if (e && e.status) return opsAuthErrorResponse(e);
      return jsonResponse({ success: false, error: String(e.message || e) }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}
