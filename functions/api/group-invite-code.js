/**
 * 小组六位邀请码（存 KV，注册时校验）。
 * GET  /api/group-invite-code?group=88  → { success, group, code }（无记录则 code 为空串）
 * POST /api/group-invite-code           body: { group: "88" } → 生成/刷新六位数字并写入 KV
 * KV 键：invite:group:{group}
 */
import {
  inviteKvKey,
  normalizeSixDigitsFromStored,
  sanitizeGroupForInvite,
  writeNewInviteCodeToKv,
} from "../lib/group-invite-kv.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
      const url = new URL(request.url);
      const g = sanitizeGroupForInvite(url.searchParams.get("group"));
      if (!g) {
        return jsonResponse({ success: false, error: "Missing or invalid group" }, 400);
      }
      const raw = await kv.get(inviteKvKey(g));
      let code = "";
      if (raw && typeof raw === "string") {
        try {
          const o = JSON.parse(raw);
          code = normalizeSixDigitsFromStored(o && o.code != null ? o.code : "");
        } catch {
          code = "";
        }
      }
      return jsonResponse({ success: true, group: g, code });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const g = sanitizeGroupForInvite(body && body.group != null ? body.group : "");
      if (!g) {
        return jsonResponse({ success: false, error: "Missing or invalid group" }, 400);
      }
      const code = await writeNewInviteCodeToKv(kv, g);
      return jsonResponse({ success: true, group: g, code });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  } catch (e) {
    console.error("group-invite-code:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
