/**
 * GET /api/hero-backgrounds
 * 返回首页 Hero 背景轮换配置与当前启用的媒体列表（公开读）。
 *
 * 环境变量（可选）：
 * - HERO_MEDIA_PUBLIC_BASE：R2 自定义域名或 CDN 根 URL，用于拼接 media_url
 */

import {
  ensureAllD1Tables,
} from "../lib/d1-schema.js";
import {
  getHeroBackgroundConfig,
  listActiveHeroBackgroundItems,
  pickHeroD1,
} from "../lib/hero-background-d1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const d1 = pickHeroD1(env);
  if (!d1) {
    return jsonResponse({ success: false, error: "D1 not configured" }, 500);
  }

  try {
    await ensureAllD1Tables(d1);
    const config = await getHeroBackgroundConfig(d1);
    const items = await listActiveHeroBackgroundItems(d1, env);
    return jsonResponse({
      success: true,
      config,
      items,
      item_count: items.length,
    });
  } catch (e) {
    return jsonResponse(
      { success: false, error: String((e && e.message) || e || "unknown error") },
      500
    );
  }
}
