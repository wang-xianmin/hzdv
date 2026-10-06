/**
 * 小组六位邀请码（存 KV，注册时校验）。
 * GET  /api/group-invite-code?group=88  → { success, group, code }（无记录则 code 为空串）
 * POST /api/group-invite-code           body: { group: "88" } → 生成/刷新六位数字并写入 KV
 * KV 键：ig:{HMAC(...)}（双读旧 invite:group:）
 */
import {
  readInviteCodeFromKv,
  sanitizeGroupForInvite,
  writeNewInviteCodeToKv,
} from "../lib/group-invite-kv.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { requireAuth } from "../lib/auth-token.js";
import { roleOf, authRequiredResponse, forbiddenResponse, deletedCallerResponse } from "../lib/auth-roles.js";

const SITE_DEFAULT_GROUP_KV_KEY = "site:default_register_group";

async function readSiteDefaultGroupSanitized(kv) {
  const raw = await kv.get(SITE_DEFAULT_GROUP_KV_KEY);
  if (!raw || typeof raw !== "string") return "";
  try {
    const o = JSON.parse(raw);
    return sanitizeGroupForInvite(o && o.group != null ? o.group : "");
  } catch {
    return "";
  }
}

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
      const auth = await requireAuth(context);
      const caller = auth ? roleOf(auth) : null;
      if (caller && caller.status === 3) return deletedCallerResponse();
      const canRead = !!caller && (caller.isSuper || caller.isDbg || (caller.isLeader && sanitizeGroupForInvite(caller.group) === g));
      if (!canRead) {
        const defGroup = await readSiteDefaultGroupSanitized(kv);
        if (!defGroup || defGroup !== g) return auth ? forbiddenResponse("只能查看本组邀请码") : authRequiredResponse();
      }
      const code = await readInviteCodeFromKv(kv, env, g);
      return jsonResponse({ success: true, group: g, code });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const auth = await requireAuth(context);
      if (!auth) return authRequiredResponse();
      const caller = roleOf(auth);
      if (caller.status === 3) return deletedCallerResponse();
      if (!caller.isSuper && !caller.isDbg) {
        return forbiddenResponse();
      }
      const g = sanitizeGroupForInvite(body && body.group != null ? body.group : "");
      if (!g) {
        return jsonResponse({ success: false, error: "Missing or invalid group" }, 400);
      }
      const code = await writeNewInviteCodeToKv(kv, env, g);
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
