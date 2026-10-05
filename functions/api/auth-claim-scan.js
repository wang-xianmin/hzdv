/**
 * 扫码登录令牌领取端点：POST /api/auth-claim-scan
 * Body: { nonce: string, phone: string }
 * 返回：
 * - 200 { success: true, auth: { exp } } + Set-Cookie
 * - 400 { success: false, error: "invalid_input" }
 * - 403 { success: false, error: "invalid_session"|"not_confirmed"|"phone_mismatch"|"session_expired"|"already_claimed"|"user_not_found"|"user_deleted"|"password_required" }
 * - 405 { success: false, error: "method_not_allowed" }
 * - 500 { success: false, error: "kv_error"|"token_error"|"internal_error" }
 * - 503 { success: false, error: "kv_unavailable" }
 */
import { pickKvBinding } from "../lib/kv-binding.js";
import { readKvUser } from "../lib/kv-secure.js";
import { issueAuthToken, buildAuthCookie } from "../lib/auth-token.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * 十六进制字符串转 Uint8Array
 */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Uint8Array 转十六进制字符串
 */
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequest(context) {
  const { request, env } = context;

  // 只允许 POST
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "method_not_allowed" }, 405);
  }

  // 解析 JSON
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: "invalid_input" }, 400);
  }

  const { nonce, phone } = body;
  const nonceStr = String(nonce || "").trim();
  const phoneStr = String(phone || "").replace(/\D/g, "");

  // 输入校验
  if (!/^[0-9a-f]{64}$/.test(nonceStr) || phoneStr === "") {
    return jsonResponse({ success: false, error: "invalid_input" }, 400);
  }

  // KV 可用性
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse({ success: false, error: "kv_unavailable" }, 503);
  }

  // 计算 sessionId = SHA-256(nonceBytes)
  const nonceBytes = hexToBytes(nonceStr);
  if (!nonceBytes) {
    return jsonResponse({ success: false, error: "invalid_input" }, 400);
  }

  let sessionId;
  try {
    const hashBuffer = await crypto.subtle.digest("SHA-256", nonceBytes);
    sessionId = bytesToHex(new Uint8Array(hashBuffer));
  } catch (digestErr) {
    console.error("auth-claim-scan: digest failed:", digestErr);
    return jsonResponse({ success: false, error: "internal_error" }, 500);
  }

  // 读取会话
  let sessionRaw;
  try {
    sessionRaw = await kv.get(sessionId);
  } catch (kvErr) {
    console.error("auth-claim-scan: kv.get failed:", kvErr);
    return jsonResponse({ success: false, error: "kv_error" }, 500);
  }

  if (!sessionRaw) {
    return jsonResponse({ success: false, error: "invalid_session" }, 403);
  }

  let session;
  try {
    session = JSON.parse(sessionRaw);
  } catch {
    return jsonResponse({ success: false, error: "invalid_session" }, 403);
  }

  // 会话状态校验
  if (session.emailLoginConfirmed !== true || session.confirmMethod !== 'post') {
    return jsonResponse({ success: false, error: "not_confirmed" }, 403);
  }

  if (String(session.phone || '').replace(/\D/g, '') !== phoneStr) {
    return jsonResponse({ success: false, error: "phone_mismatch" }, 403);
  }

  const confirmedAt = Number(session.confirmedAt);
  if (!isFinite(confirmedAt) || Date.now() - confirmedAt > 600000) {
    return jsonResponse({ success: false, error: "session_expired" }, 403);
  }

  if (session.tokenClaimed === true) {
    return jsonResponse({ success: false, error: "already_claimed" }, 403);
  }

  // 读取用户数据
  let userRow;
  try {
    userRow = await readKvUser(kv, env, "phone:" + phoneStr);
  } catch (userErr) {
    console.error("auth-claim-scan: readKvUser failed:", userErr);
    return jsonResponse({ success: false, error: "kv_error" }, 500);
  }

  if (!userRow) {
    return jsonResponse({ success: false, error: "user_not_found" }, 403);
  }

  const meta = userRow.metadata || {};
  let userStatus = parseInt(meta.status, 10);
  if (isNaN(userStatus)) userStatus = null;
  if (userStatus === 3) {
    return jsonResponse({ success: false, error: "user_deleted" }, 403);
  }

  // 检查是否需要密码（超管判断）
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
  if (isSuperuser) {
    return jsonResponse({ success: false, error: "password_required" }, 403);
  }

  // 标记已领取（防重放）
  const updatedSession = { ...session, tokenClaimed: true };
  try {
    await kv.put(sessionId, JSON.stringify(updatedSession), { expirationTtl: 600 });
  } catch (putErr) {
    console.error("auth-claim-scan: kv.put (mark claimed) failed:", putErr);
    return jsonResponse({ success: false, error: "kv_error" }, 500);
  }

  // 签发令牌
  let token, exp;
  try {
    const tv = Number((userRow.value || {}).tv || 0);
    const issued = await issueAuthToken(env, phoneStr, { tv });
    token = issued.token;
    exp = issued.exp;
  } catch (tokenErr) {
    console.error("auth-claim-scan: issueAuthToken failed:", tokenErr);
    return jsonResponse({ success: false, error: "token_error" }, 500);
  }

  // 成功响应
  const authCookieHeader = buildAuthCookie(token, 2592000);
  return jsonResponse(
    { success: true, auth: { exp } },
    200,
    { "Set-Cookie": authCookieHeader }
  );
}
