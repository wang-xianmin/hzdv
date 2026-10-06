/**
 * 用户密码登录校验（KV 实时）：POST /api/check-user
 * Body: { phone, password?, email?, username? }
 * 返回：{ success, phone_exists, password_matches|null, password_verifiable|null,
 *   user_status, email_matches, username_matches, stored_email, stored_username, is_superuser }
 * password_verifiable：已传 password 且 KV 中存在可校验材料时为 true；无材料为 false；未传 password 为 null。
 */
import {
  assertPhoneKey,
  readKvUser,
  verifyPasswordArgon2idEncodedFlexible,
} from "../lib/kv-secure.js";
import { normalizePasswordForAuth } from "../lib/password-normalize.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import { issueAuthToken, buildAuthCookie } from "../lib/auth-token.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function normalizeEmail(v) {
  const raw = String(v || "").trim().toLowerCase();
  if (!raw || raw.indexOf("@") < 0) return raw;
  const at = raw.lastIndexOf("@");
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  // Gmail 常见别名归一化：忽略 local part 的点号与 +tag
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return local + "@" + domain;
}

function normalizeUsername(v) {
  return String(v || "").trim().toLowerCase();
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
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
    const phone = String(body.phone || "").trim();
    const passwordRawForVerify = body.password != null ? String(body.password) : "";
    const passwordNorm = normalizePasswordForAuth(passwordRawForVerify);
    const email = String(body.email || "").trim();
    const username = String(body.username || "").trim();
    if (!phone) return jsonResponse({ success: false, error: "Missing phone" }, 400);
    const key = "phone:" + phone;
    try {
      assertPhoneKey(key);
    } catch (e) {
      return jsonResponse({ success: false, error: String(e.message || e) }, 400);
    }

    // 读取 KV 多次退避重试（边缘 / KV 瞬时 503 时常见；Argon 校验前尽量读成功）
    let row = null;
    let lastReadErr = null;
    for (let i = 0; i < 8; i++) {
      try {
        row = await readKvUser(kv, env, key);
        lastReadErr = null;
        break;
      } catch (e) {
        lastReadErr = e;
        if (i < 7) {
          await sleepMs(80 + i * 140 + Math.floor(Math.random() * 120));
        }
      }
    }
    if (lastReadErr) {
      throw lastReadErr;
    }
    if (!row) {
      return jsonResponse({
        success: true,
        phone_exists: false,
        password_matches: null,
        user_status: null,
        email_matches: false,
        username_matches: false,
        stored_email: null,
        stored_username: null,
        is_superuser: false,
        user_type: 0,
        user_group: "",
        user_g_role: 0,
      });
    }

    const value = row.value || {};
    const meta = row.metadata || {};
    const storedEmail = value.email != null ? String(value.email) : "";
    const emailNorm = normalizeEmail(email);
    const storedEmailNorm = normalizeEmail(storedEmail);
    const storedUsername = value.name != null ? String(value.name) : "";
    const usernameNorm = normalizeUsername(username);
    const storedUsernameNorm = normalizeUsername(storedUsername);
    const pwdRaw = value.pwd != null ? String(value.pwd) : "";
    const pwdHash = value.pwd_hash != null ? String(value.pwd_hash) : "";
    /** 调试用：仅长度，不包含明文；KV 为哈希时 pwd 字段长度反映哈希串长而非口令字数 */
    const passwordDebug =
      passwordNorm !== ""
        ? {
            input_len: passwordNorm.length,
            kv_pwd_field_len: pwdRaw.length,
            kv_pwd_hash_field_len: pwdHash.length,
          }
        : null;
    /** 帮助排查「密码错」：与 kv-secure 内 KDF 校验实际支持类型一致 */
    let passwordHashFormat = "none";
    if (pwdHash) {
      const ph = pwdHash.trim();
      if (ph.indexOf("$kdf-sha256$") === 0) passwordHashFormat = "kdf_sha256";
      else if (ph.indexOf("$argon2id$") === 0) passwordHashFormat = "argon2id_unsupported";
      else if (ph.length > 0) passwordHashFormat = "unknown_hash_prefix";
    } else if (pwdRaw && pwdRaw.indexOf("$argon2") === 0) {
      passwordHashFormat = "argon2id_in_pwd_field_unsupported";
    } else if (pwdRaw !== "") {
      passwordHashFormat = "plaintext_only";
    }
    let passwordMatches = null;
    /** 是否存在可校验的密码材料（明文或 Argon 串） */
    let passwordMaterialPresent = false;
    const pwdRawNorm = pwdRaw && pwdRaw.charAt(0) !== "$" ? normalizePasswordForAuth(pwdRaw) : "";
    if (passwordNorm) {
      if (pwdHash) {
        passwordMaterialPresent = true;
        passwordMatches = await verifyPasswordArgon2idEncodedFlexible(passwordRawForVerify, pwdHash);
        // 兼容历史数据：若哈希校验失败但仍保留明文 pwd，则回退到明文比对，避免误判“密码错”
        if (passwordMatches !== true && pwdRaw && pwdRaw.indexOf('$argon2') !== 0) {
          passwordMatches = pwdRawNorm === passwordNorm;
        }
      } else if (pwdRaw && pwdRaw.indexOf("$argon2") === 0) {
        passwordMaterialPresent = true;
        passwordMatches = await verifyPasswordArgon2idEncodedFlexible(passwordRawForVerify, pwdRaw);
      } else if (pwdRaw !== "") {
        passwordMaterialPresent = true;
        passwordMatches = pwdRawNorm === passwordNorm;
      }
    }

    const typeRaw = String(
      meta.type != null && String(meta.type) !== "" ? meta.type : meta.uA != null ? meta.uA : ""
    ).trim();
    let typeMask = 0;
    if (/^[01]+$/.test(typeRaw)) {
      typeMask = parseInt(typeRaw, 2) || 0;
    } else {
      typeMask = parseInt(typeRaw, 10) || 0;
    }
    const isSuperuser = (typeMask & 1) !== 0;
    const userGroup = value.group != null ? String(value.group) : "";
    const userGRole =
      value.g_role != null && Number(value.g_role) === 1 ? 1 : 0;

    let userStatus = parseInt(meta.status, 10);
    if (isNaN(userStatus)) userStatus = null;
    const emailMatches = email ? storedEmailNorm === emailNorm : false;
    const usernameMatches = username ? storedUsernameNorm === usernameNorm : false;

    const avatar_url = value.avatar_url != null ? String(value.avatar_url) : "";
    const avatar_r2_key =
      value.avatar_r2_key != null ? String(value.avatar_r2_key) : "";
    const avatar_data_url =
      value.avatar_data_url != null ? String(value.avatar_data_url) : "";

    let authCookieHeader = null;
    let authPayload = null;
    if (passwordMatches === true && userStatus !== 3) {
      try {
        const { token, exp } = await issueAuthToken(env, phone, { tv: Number(value.tv || 0) });
        authCookieHeader = buildAuthCookie(token, 2592000);
        authPayload = { exp };
      } catch (tokenErr) {
        console.error("check-user token issue:", tokenErr);
      }
    }

    const reveal = passwordMatches === true || emailMatches === true;

    return jsonResponse({
      success: true,
      phone_exists: true,
      password_matches: passwordMatches,
      password_verifiable: passwordNorm ? passwordMaterialPresent : null,
      /** 与 Functions 内验证实现对照；argon2id_* 时校验恒 false，需明文 pwd 或改密迁移为 kdf_sha256 */
      password_hash_format: passwordHashFormat,
      ...(passwordDebug && passwordMatches === true ? { password_debug: passwordDebug } : {}),
      user_status: userStatus,
      email_matches: emailMatches,
      username_matches: usernameMatches,
      stored_email: reveal ? storedEmail : "",
      stored_username: reveal ? storedUsername : "",
      is_superuser: reveal ? isSuperuser : false,
      user_data: reveal ? {
        other_data: value.uuid != null ? String(value.uuid) : "",
        pwd: passwordMatches === true ? String(value.pwd ?? "") : "",
        avatar_url,
        avatar_r2_key,
        avatar_data_url,
        type: typeMask,
        group: userGroup,
        g_role: userGRole,
      } : {
        other_data: "",
        pwd: "",
        avatar_url: "",
        avatar_r2_key: "",
        avatar_data_url: "",
        type: 0,
        group: "",
        g_role: 0,
      },
      ...(authPayload ? { auth: authPayload } : {}),
    }, 200, authCookieHeader ? { "Set-Cookie": authCookieHeader } : {});
  } catch (e) {
    console.error("check-user:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}

