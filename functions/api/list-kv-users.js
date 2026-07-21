/**
 * 列出 KV 中所有新人用户
 * GET /api/list-kv-users           → 扫描 uk: + 旧 phone:；响应 key 仍为逻辑 phone:
 * GET /api/list-kv-users?group=67  → 走组索引 gix:（双读旧 group:）
 * 返回 { success, users: [{ key, value, metadata }] }
 */
import {
  listKvUserStorageKeys,
  readKvUserByStorageKey,
} from "../lib/kv-secure.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { listUsersByGroupIndex, normalizeGroup } from "../lib/group-index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 全量扫描：uk: + 旧 phone:；对外 key 统一为逻辑 phone: */
async function listAll(kv, env) {
  const storageKeys = await listKvUserStorageKeys(kv);
  const seen = new Set();
  const users = [];
  for (const sk of storageKeys) {
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row) continue;
      const logicalKey = row.logicalKey;
      if (!logicalKey || seen.has(logicalKey)) continue;
      seen.add(logicalKey);
      users.push({
        key: logicalKey,
        value: row.value,
        metadata: row.metadata,
      });
    } catch {
      /* skip corrupt */
    }
  }
  users.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return users;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
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
    const url = new URL(request.url);
    const groupParam = (url.searchParams.get("group") || "").trim();

    if (groupParam) {
      const g = normalizeGroup(groupParam);
      if (!g) {
        return jsonResponse({ success: false, error: "Invalid group" }, 400);
      }
      const users = await listUsersByGroupIndex(kv, env, g);
      return jsonResponse({ success: true, users, group: g });
    }

    const users = await listAll(kv, env);
    return jsonResponse({ success: true, users });
  } catch (e) {
    console.error("list-kv-users:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
