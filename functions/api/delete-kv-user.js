/**
 * 从 KV 删除指定用户（key 须为 phone: 前缀）并清理关联数据
 * POST /api/delete-kv-user  Body: { key: "phone:13800138000" }
 *
 * 【数据安全】本仓库内仅此接口会删除生产环境的 D1 `avatars` 行与 R2 对象。
 * 若发现头像「全部消失」，请排查：① 是否误调本 API（含脚本/测试）；② Pages 是否换绑了空的 D1/R2；
 * ③ 是否在控制台重置过 D1 或清空过 R2 Bucket。勿在其它 Function 中复制「按 uuid 删 D1/R2」逻辑。
 *
 * 删除顺序：
 * 1) 读取 KV 用户 value（uuid/phone/group）
 * 2) 读取 D1 avatars 表中该 uuid 对应 r2_key
 * 3) 删除 R2 对象
 * 4) 删除 D1 avatars 行
 * 5) 删除组索引（group:{group}:l/m:{phone}）
 * 6) 删除主 KV 记录（phone:...）
 */
import { assertPhoneKey, deleteKvUser, readKvUser } from "../lib/kv-secure.js";
import { getPhoneFromPhoneKey, removeUserGroupIndexes } from "../lib/group-index.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { pickD1Binding, pickR2Binding } from "../lib/cloudflare-bindings.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeAvatarR2Key(rawKey) {
  const key = String(rawKey || "").trim().replace(/^\/+/, "");
  if (!key) return "";
  // 仅允许 avatars/ 子目录；历史若存裸文件名则补前缀
  return key.startsWith("avatars/") ? key : `avatars/${key}`;
}

async function getAvatarR2KeysByUuid(d1, uuid) {
  if (!d1 || !uuid) return [];
  const rs = await d1
    .prepare("SELECT r2_key FROM avatars WHERE uuid = ? AND lower(category) = 'customs'")
    .bind(uuid)
    .all();
  const rows = (rs && rs.results) || [];
  return rows
    .map((r) => normalizeAvatarR2Key(r && r.r2_key))
    .filter((x) => !!x);
}

async function deleteAvatarRowsByUuid(d1, uuid) {
  if (!d1 || !uuid) return 0;
  const rs = await d1
    .prepare("DELETE FROM avatars WHERE uuid = ? AND lower(category) = 'customs'")
    .bind(uuid)
    .run();
  return rs && typeof rs.changes === "number" ? rs.changes : 0;
}

function envAvatarDeleteEnabled(env) {
  const s = String(env.ENABLE_AVATAR_DELETE ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function ensureDeleteAuditTable(d1) {
  if (!d1) return;
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS delete_kv_user_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        key_text TEXT NOT NULL,
        uuid TEXT,
        phone TEXT,
        group_text TEXT,
        avatar_delete_enabled_env INTEGER NOT NULL DEFAULT 0,
        avatar_delete_confirmed_request INTEGER NOT NULL DEFAULT 0,
        avatar_delete_executed INTEGER NOT NULL DEFAULT 0,
        r2_keys_found INTEGER NOT NULL DEFAULT 0,
        r2_deleted INTEGER NOT NULL DEFAULT 0,
        d1_deleted_rows INTEGER NOT NULL DEFAULT 0,
        group_index_deleted INTEGER NOT NULL DEFAULT 0,
        cf_connecting_ip TEXT,
        user_agent TEXT,
        note TEXT
      )`
    )
    .run();
}

async function writeDeleteAuditRow(d1, data) {
  if (!d1) return;
  await ensureDeleteAuditTable(d1);
  await d1
    .prepare(
      `INSERT INTO delete_kv_user_audit (
        created_at, key_text, uuid, phone, group_text,
        avatar_delete_enabled_env, avatar_delete_confirmed_request, avatar_delete_executed,
        r2_keys_found, r2_deleted, d1_deleted_rows, group_index_deleted,
        cf_connecting_ip, user_agent, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      Number(data.created_at || Date.now()),
      data.key_text || "",
      data.uuid || null,
      data.phone || null,
      data.group_text || null,
      data.avatar_delete_enabled_env ? 1 : 0,
      data.avatar_delete_confirmed_request ? 1 : 0,
      data.avatar_delete_executed ? 1 : 0,
      Number(data.r2_keys_found || 0),
      Number(data.r2_deleted || 0),
      Number(data.d1_deleted_rows || 0),
      Number(data.group_index_deleted || 0),
      data.cf_connecting_ip || null,
      data.user_agent || null,
      data.note || null
    )
    .run();
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
    const body = await request.json();
    const key = String(body && body.key != null ? body.key : "").trim();
    if (!key || typeof key !== "string") {
      return jsonResponse({ success: false, error: "Missing key" }, 400);
    }
    try {
      assertPhoneKey(key);
    } catch (e) {
      return jsonResponse({ success: false, error: String(e.message || e) }, 400);
    }

    const allowAvatarDeleteEnv = envAvatarDeleteEnabled(env);
    const confirmAvatarDelete =
      body && (body.confirmAvatarDelete === true || body.confirm_avatar_delete === true);
    const allowAvatarDelete = allowAvatarDeleteEnv && confirmAvatarDelete;

    const reqIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for") ||
      "";
    const reqUa = request.headers.get("User-Agent") || "";

    // ① 读取 KV value
    const row = await readKvUser(kv, env, key);
    const value = row && row.value && typeof row.value === "object" ? row.value : {};
    const uuid = String(value.uuid == null ? "" : value.uuid).trim();
    const group = String(value.group == null ? "" : value.group).trim();
    const phone = getPhoneFromPhoneKey(key);

    // ② 读取 D1 avatars 对应 r2_key（仅在显式允许删头像时执行）
    const d1 = pickD1Binding(env);
    const r2 = pickR2Binding(env);
    let r2Keys = [];
    if (allowAvatarDelete && uuid && d1) {
      try {
        r2Keys = await getAvatarR2KeysByUuid(d1, uuid);
      } catch (e) {
        console.warn("delete-kv-user read D1 avatars failed:", e);
      }
    }

    // ③ 删除 R2 数据（止血：默认关闭，需 env+请求体双确认）
    let r2Deleted = 0;
    if (allowAvatarDelete && r2 && r2Keys.length) {
      for (const k of r2Keys) {
        try {
          await r2.delete(k);
          r2Deleted++;
        } catch (e) {
          console.warn("delete-kv-user delete R2 failed:", k, e);
        }
      }
    }

    // ④ 删除 D1 avatars 整行（止血：默认关闭，需 env+请求体双确认）
    let d1DeletedRows = 0;
    if (allowAvatarDelete && uuid && d1) {
      try {
        d1DeletedRows = await deleteAvatarRowsByUuid(d1, uuid);
      } catch (e) {
        console.warn("delete-kv-user delete D1 avatars failed:", e);
      }
    }

    // ⑤ 删除组索引（组员/组长，新旧格式）
    let groupIndexDeleted = 0;
    if (group && phone) {
      try {
        groupIndexDeleted = await removeUserGroupIndexes(kv, env, group, phone);
      } catch (e) {
        console.warn("delete-kv-user delete group indexes failed:", e);
      }
    }

    // ⑥ 删除主 KV 记录（uk: + 旧 phone:，幂等）
    await deleteKvUser(kv, env, key);

    // ⑦ 记审计（即使头像未执行删除，也记录本次调用）
    try {
      await writeDeleteAuditRow(d1, {
        created_at: Date.now(),
        key_text: key,
        uuid,
        phone,
        group_text: group,
        avatar_delete_enabled_env: allowAvatarDeleteEnv,
        avatar_delete_confirmed_request: confirmAvatarDelete,
        avatar_delete_executed: allowAvatarDelete,
        r2_keys_found: r2Keys.length,
        r2_deleted: r2Deleted,
        d1_deleted_rows: d1DeletedRows,
        group_index_deleted: groupIndexDeleted,
        cf_connecting_ip: reqIp,
        user_agent: reqUa,
        note: allowAvatarDelete
          ? "avatar delete executed"
          : "avatar delete skipped by safety gate",
      });
    } catch (e) {
      console.warn("delete-kv-user write audit failed:", e);
    }

    return jsonResponse({
      success: true,
      key,
      uuid,
      phone,
      group,
      avatar_delete_enabled_env: allowAvatarDeleteEnv,
      avatar_delete_confirmed_in_request: confirmAvatarDelete,
      avatar_delete_executed: allowAvatarDelete,
      r2_keys_found: r2Keys.length,
      r2_deleted: r2Deleted,
      d1_deleted_rows: d1DeletedRows,
      group_index_deleted: groupIndexDeleted,
      d1_bound: !!d1,
      r2_bound: !!r2,
    });
  } catch (e) {
    console.error("delete-kv-user:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
