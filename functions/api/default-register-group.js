import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

/**
 * 全站新人默认组（无邀请链接时使用），存于 KV，与浏览器/账号设备无关。
 * GET  /api/default-register-group  → { success, group }
 * POST /api/default-register-group  body: { group: "85" | "" } ；空字符串表示清空
 * KV 键：site:default_register_group（与 phone: 前缀隔离）
 */
const SITE_DEFAULT_GROUP_KV_KEY = "site:default_register_group";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function sanitizeGroup(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s || s.length > 24) return "";
  if (!/^[\dA-Za-z._-]+$/.test(s)) return "";
  return s;
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse(
      {
        success: false,
        error: "KV not configured",
        hint: kvBindingHint(),
      },
      503
    );
  }

  try {
    if (request.method === "GET") {
      const raw = await kv.get(SITE_DEFAULT_GROUP_KV_KEY);
      let group = "";
      if (raw && typeof raw === "string") {
        try {
          const o = JSON.parse(raw);
          group = sanitizeGroup(o && o.group != null ? o.group : "");
        } catch {
          group = "";
        }
      }
      return jsonResponse({ success: true, group });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const groupRaw = body && body.group != null ? body.group : "";
      const g = sanitizeGroup(groupRaw);
      if (!g) {
        await kv.delete(SITE_DEFAULT_GROUP_KV_KEY);
        return jsonResponse({ success: true, group: "" });
      }
      await kv.put(
        SITE_DEFAULT_GROUP_KV_KEY,
        JSON.stringify({
          group: g,
          updated_at: Date.now(),
        })
      );
      return jsonResponse({ success: true, group: g });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  } catch (e) {
    console.error("default-register-group:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
