/**
 * 列出 KV 中所有新人用户
 * GET /api/list-kv-users           → 全量扫描 phone: 前缀
 * GET /api/list-kv-users?group=67  → 走组索引 group:{g}: 前缀，高效取本组成员
 * 返回 { success, users: [{ key, value, metadata }] }
 * 加密存储由 kv-secure 解密后输出（与旧版 JSON 结构一致）。
 */
import { readKvUser } from "../lib/kv-secure.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { normalizeGroup } from "../lib/group-index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 从组索引 key 提取手机号，如 group:67:l:13800138000 → 13800138000 */
function extractPhoneFromIndexKey(indexKey) {
  if (!indexKey) return "";
  const parts = String(indexKey).split(":");
  // group:{g}:{l|m}:{phone}
  if (parts.length < 4) return "";
  return parts.slice(3).join(":");
}

/** 走组索引：列出 group:{g}: 下所有索引 key，提取手机号，再读 phone: 记录 */
async function listByGroupIndex(kv, env, g) {
  const prefix = `group:${g}:`;
  const indexKeys = [];
  let idxCursor;
  do {
    const page = await kv.list({
      prefix,
      limit: 1000,
      cursor: idxCursor,
    });
    if (page.keys && page.keys.length) {
      for (const k of page.keys) {
        if (k && k.name) indexKeys.push(k.name);
      }
    }
    idxCursor = page.list_complete ? undefined : page.cursor;
  } while (idxCursor);

  console.log(`[listByGroupIndex] prefix=${prefix} indexKeys=${indexKeys.length} keys=${JSON.stringify(indexKeys.slice(0, 20))}`);

  const users = [];
  let skipped = 0;
  let readFailed = 0;
  for (const ik of indexKeys) {
    try {
      const phone = extractPhoneFromIndexKey(ik);
      if (!phone) { skipped++; continue; }
      const phoneKey = `phone:${phone}`;
      const row = await readKvUser(kv, env, phoneKey);
      if (!row) { readFailed++; continue; }
      /** 组长模式：剥离 uuid/pwd 等敏感字段 */
      if (row.value && typeof row.value === 'object') {
        delete row.value.uuid;
        delete row.value.pwd;
      }
      users.push({
        key: phoneKey,
        value: row.value,
        metadata: row.metadata,
      });
    } catch {
      readFailed++;
    }
  }
  console.log(`[listByGroupIndex] users=${users.length} skipped=${skipped} readFailed=${readFailed} firstPhone=${users.length > 0 ? users[0].key : 'none'}`);
  users.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return users;
}

/** 全量扫描：列出所有 phone: 用户 */
async function listAll(kv, env) {
  const allKeys = [];
  let cursor;
  do {
    const page = await kv.list({
      prefix: "phone:",
      limit: 1000,
      cursor,
    });
    if (page.keys && page.keys.length) {
      for (const k of page.keys) {
        if (k && k.name) allKeys.push(k.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const users = [];
  for (const key of allKeys) {
    try {
      const row = await readKvUser(kv, env, key);
      if (!row) continue;
      users.push({
        key,
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
      const users = await listByGroupIndex(kv, env, g);
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
