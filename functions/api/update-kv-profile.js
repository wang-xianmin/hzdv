/**
 * 已注册用户更新 KV 中的 value/metadata（个人资料用户名、密码等）
 * 须携带有效登录令牌（hz_auth）；权限见 ../lib/auth-roles.js
 * POST /api/update-kv-profile
 * Body: { key, value, metadata } — 须为完整对象；key 必须在 KV 中已存在。
 * KV 加密见 ../lib/kv-secure.js。
 */
import { assertPhoneKey, readKvUser, writeKvUser } from "../lib/kv-secure.js";
import { getPhoneFromPhoneKey, syncUserGroupIndexOnUpdate } from "../lib/group-index.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { requireAuth, issueAuthToken, buildAuthCookie } from "../lib/auth-token.js";
import { roleOf, parseTypeMask, keepServerManagedValueKeys, sanitizeValueForViewer, authRequiredResponse, forbiddenResponse, deletedCallerResponse } from "../lib/auth-roles.js";
import { normalizePasswordForAuth } from "../lib/password-normalize.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
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

  const auth = await requireAuth(context);
  if (!auth) return authRequiredResponse();
  const caller = roleOf(auth);
  if (caller.status === 3) return deletedCallerResponse();

  try {
    const body = await request.json();
    const key = body.key;
    const value = body.value;
    const metadata = body.metadata ?? {};
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
      (metadata !== undefined && metadata !== null && typeof metadata !== "object")
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

    const target = roleOf(prev);
    const isSelf = key === "phone:" + auth.phone;

    let valueIn, metaIn;
    if (caller.isSuper) {
      valueIn = value;
      metaIn = metadata;
    } else if (caller.isDbg) {
      if (target.isSuper) return forbiddenResponse("无权限修改超管账号");
      valueIn = value;
      metaIn = metadata;
    } else {
      if (!isSelf) return forbiddenResponse();
      const allowedKeys = ["name", "email", "pwd", "avatar_url", "avatar_r2_key", "avatar_data_url"];
      valueIn = {};
      for (const k of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(value, k)) valueIn[k] = value[k];
      }
      metaIn = {};
    }

    if (valueIn.pwd == null || String(valueIn.pwd).trim() === "") {
      valueIn = { ...valueIn };
      delete valueIn.pwd;
    }

    const valueMerged = Object.assign({}, prev.value || {}, valueIn);
    const metadataMerged = Object.assign({}, prev.metadata || {}, metaIn);
    keepServerManagedValueKeys(valueMerged, prev.value);
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

    if (caller.isDbg && !caller.isSuper) {
      const newRole = roleOf({ value: valueMerged, metadata: metadataMerged });
      const addSuper = (newRole.isSuper && !target.isSuper) ||
        ((parseTypeMask(metadataMerged.uA) & 1) !== 0 && (parseTypeMask((prev.metadata || {}).uA) & 1) === 0);
      if (addSuper) return forbiddenResponse("技术调试员不能授予超管权限");
    }

    const prevPwd = String((prev.value || {}).pwd == null ? "" : prev.value.pwd);
    const pwdChanged = valueIn.pwd != null && normalizePasswordForAuth(String(valueIn.pwd)) !== prevPwd;
    let newCookie = null, authPayload = null;
    if (pwdChanged) {
      const newTv = Number((prev.value || {}).tv || 0) + 1;
      valueMerged.tv = newTv;
      if (isSelf) {
        try {
          const { token, exp } = await issueAuthToken(env, auth.phone, { tv: newTv });
          newCookie = buildAuthCookie(token, 2592000);
          authPayload = { exp };
        } catch (e) {
          return jsonResponse({ success: false, error: "令牌签发失败，密码未修改" }, 500);
        }
      }
    }
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
      value: sanitizeValueForViewer(valueToStore, caller.isSuper || isSelf),
      metadata: metadataMerged,
      index_sync: indexSync,
      index_synced: indexSynced,
      index_sync_warning: indexSyncWarning,
      ...(authPayload ? { auth: authPayload } : {}),
    }, 200, newCookie ? { "Set-Cookie": newCookie } : {});
  } catch (e) {
    console.error("update-kv-profile:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
