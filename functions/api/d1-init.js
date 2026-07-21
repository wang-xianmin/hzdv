/**
 * GET  /api/d1-init           — 查看 D1 是否绑定、现有表清单
 * POST /api/d1-init           — 一键建表（需 Header: X-Maintenance-Secret）
 *
 * Body（POST，可选）：
 * { "secret": "..." }         — 也可放在 JSON body
 */

import {
  ensureAllD1Tables,
  getD1SchemaStatus,
  pickD1Binding,
} from "../lib/d1-schema.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function readMaintenanceSecret(request, body) {
  const header = String(request.headers.get("X-Maintenance-Secret") || "").trim();
  if (header) return header;
  if (body && body.secret != null) return String(body.secret).trim();
  return "";
}

function isAuthorized(env, provided) {
  const expected = String(env.MAINTENANCE_SECRET || "").trim();
  if (!expected) return false;
  return provided === expected;
}

export async function onRequest(context) {
  const { request, env } = context;
  const d1 = pickD1Binding(env);

  if (!d1) {
    return jsonResponse(
      {
        success: false,
        error: "D1 not bound to Pages",
        hint:
          "Cloudflare Pages → hzdv → Settings → Bindings → Add D1，变量名填 hzdvd1（或 DV_D1 / D1 / AVATARS_DB）",
      },
      503
    );
  }

  if (request.method === "GET") {
    try {
      const status = await getD1SchemaStatus(d1);
      return jsonResponse({
        success: true,
        bound: true,
        ...status,
      });
    } catch (e) {
      return jsonResponse(
        { success: false, error: String((e && e.message) || e || "unknown error") },
        500
      );
    }
  }

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
    if (!isAuthorized(env, readMaintenanceSecret(request, body))) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }
    try {
      await ensureAllD1Tables(d1);
      const status = await getD1SchemaStatus(d1);
      return jsonResponse({
        success: true,
        message: "D1 tables ensured",
        ...status,
      });
    } catch (e) {
      return jsonResponse(
        { success: false, error: String((e && e.message) || e || "unknown error") },
        500
      );
    }
  }

  return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
}
