/**
 * POST /api/refresh-group-invite-codes
 * body: {}  → 为「全部用户中出现的组号」+「全站默认组（若有）」各生成新六位邀请码
 * body: { group: "88" } → 仅刷新该组
 */
import { collectDistinctGroupIdsFromKvUsers } from "../lib/group-index.js";
import {
  sanitizeGroupForInvite,
  writeNewInviteCodeToKv,
} from "../lib/group-invite-kv.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

const SITE_DEFAULT_GROUP_KV_KEY = "site:default_register_group";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }
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
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim()) body = JSON.parse(text);
    } catch {
      body = {};
    }
    const groupRaw =
      body && body.group != null ? String(body.group).trim() : "";
    if (groupRaw) {
      const g = sanitizeGroupForInvite(groupRaw);
      if (!g) {
        return jsonResponse(
          { success: false, error: "Missing or invalid group" },
          400
        );
      }
      const code = await writeNewInviteCodeToKv(kv, env, g);
      return jsonResponse({
        success: true,
        scope: "group",
        group: g,
        refreshed: 1,
        codes: [{ group: g, code }],
      });
    }

    const fromUsers = await collectDistinctGroupIdsFromKvUsers(kv, env);
    const defG = await readSiteDefaultGroupSanitized(kv);
    const uniq = new Set(fromUsers);
    if (defG) uniq.add(defG);
    const groups = Array.from(uniq).sort();
    const codes = [];
    for (const g of groups) {
      const code = await writeNewInviteCodeToKv(kv, env, g);
      codes.push({ group: g, code });
    }
    return jsonResponse({
      success: true,
      scope: "all",
      refreshed: codes.length,
      codes,
    });
  } catch (e) {
    console.error("refresh-group-invite-codes:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
