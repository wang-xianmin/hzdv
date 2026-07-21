/**
 * 已注册用户更新 KV 中的 value/metadata（个人资料用户名、密码等）
 * POST /api/update-kv-profile
 * Body: { key, value, metadata } — 须为完整对象；key 必须在 KV 中已存在。
 * 不要求 Turnstile（与持有本地收据的浏览器会话一致；若需加强可后续加鉴权）。
 * KV 加密见 ../lib/kv-secure.js。
 */
import { assertPhoneKey, readKvUser, writeKvUser } from "../lib/kv-secure.js";
import { getPhoneFromPhoneKey, syncUserGroupIndexOnUpdate } from "../lib/group-index.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
    const key = body.key;
    const value = body.value;
    const metadata = body.metadata;
    if (!key || typeof key !== "string") {
      return jsonResponse({ success: false, error: "Missing key" }, 400);
    }
    try {
      assertPhoneKey(key);
    } catch (e) {
      return jsonResponse({ success: false, error: String(e.message || e) }, 400);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      typeof metadata !== "object" ||
      metadata === null
    ) {
      return jsonResponse(
        { success: false, error: "value and metadata must be objects" },
        400
      );
    }

    let prev;
    try {
      prev = await readKvUser(kv, env, key);
    } catch (e) {
      return jsonResponse(
        { success: false, error: "KV 数据损坏: " + String(e.message || e) },
        500
      );
    }
    if (prev == null) {
      return jsonResponse(
        {
          success: false,
          error: "用户记录不存在，无法更新",
          code: "NOT_FOUND",
        },
        404
      );
    }

    /** 与已有 KV 浅合并，避免客户端收据缺字段时覆盖掉权限等 metadata / value */
    const valueMerged = Object.assign({}, prev.value || {}, value || {});
    const metadataMerged = Object.assign({}, prev.metadata || {}, metadata || {});
    /** 已废弃：原「权限设置」列，保存时从 metadata 剔除 */
    [
      "uA_perms",
      "uA_act_perms",
      "stfA_perms_can_ban_post",
      "uA_perms_add",
      "uA_perms_del",
      "uA_perms_block",
      "uA_perms_unban_usr",
      "uA_perms_act_post",
      "uA_perms_act_cmt",
      "uA_perms_act_hide",
      "uA_perms_act_del",
    ].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(metadataMerged, k)) {
        delete metadataMerged[k];
      }
    });
    const valueToStore = valueMerged;

    try {
      await writeKvUser(kv, env, key, valueToStore, metadataMerged);
    } catch (e) {
      return jsonResponse(
        { success: false, error: String(e.message || e) },
        500
      );
    }

    let indexSync = { deleted: 0, added: 0 };
    let indexSynced = true;
    let indexSyncWarning = "";
    try {
      const phone = getPhoneFromPhoneKey(key);
      if (phone) {
        indexSync = await syncUserGroupIndexOnUpdate(
          kv,
          env,
          phone,
          prev.value || {},
          valueToStore || {}
        );
      }
    } catch (e) {
      indexSynced = false;
      indexSyncWarning = String(e && (e.message || e));
      console.warn("update-kv-profile group-index sync failed:", e);
    }
    return jsonResponse({
      success: true,
      key,
      value: valueToStore,
      metadata: metadataMerged,
      index_sync: indexSync,
      index_synced: indexSynced,
      index_sync_warning: indexSyncWarning,
    });
  } catch (e) {
    console.error("update-kv-profile:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
