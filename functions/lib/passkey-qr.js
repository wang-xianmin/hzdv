/**
 * Passkey QR 会话（跨设备扫码登录握手区）D1 辅助。
 *
 * 表：passkey_qr_sessions（migrations/0006_passkey_qr_sessions.sql）
 * 身份源仍是 passkey_credentials；本模块只管理临时握手状态，TTL <= 5min。
 * 会话交接：session_token 明文只放这里，由 claim 原子取走一次；hash 落 auth_sessions。
 */

export const QR_SESSION_MAX_TTL_MS = 300000; // 5 分钟硬上限

/** QR 会话 TTL（毫秒），硬上限 5 分钟。 */
export function qrTtlMs(env) {
  const raw = Number(env && env.PASSKEY_QR_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return QR_SESSION_MAX_TTL_MS;
  return Math.min(QR_SESSION_MAX_TTL_MS, Math.floor(raw));
}

/** session_id 必须是 UUID v4 形态，避免把任意字符串塞进 D1。 */
export function isQrSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

/** user_key('phone:<digits>') → 掩码（139****1111），用于桌面确认提示。 */
export function maskUserKey(userKey) {
  const digits = String(userKey || "").replace(/^phone:/, "");
  if (digits.length <= 7) return digits ? digits.slice(0, 1) + "****" : "";
  return digits.slice(0, 3) + "****" + digits.slice(-4);
}

export async function insertQrSession(d1, { sessionId, rpId, origin, ttlMs }) {
  const now = Date.now();
  const expiresAt = now + Math.max(1000, Math.min(QR_SESSION_MAX_TTL_MS, ttlMs | 0));
  await d1
    .prepare(
      `INSERT INTO passkey_qr_sessions (
         session_id, status, user_key, user_uuid, challenge_hash, challenge_plain,
         rp_id, origin, session_token, created_at, expires_at, flow)
       VALUES (?, 'pending', NULL, '', NULL, NULL, ?, ?, NULL, ?, ?, 'login')`
    )
    .bind(sessionId, rpId, origin, now, expiresAt)
    .run();
  return { createdAt: now, expiresAt };
}

export async function findQrSession(d1, sessionId) {
  const row = await d1
    .prepare(
      `SELECT session_id, status, user_key, user_uuid, challenge_hash, challenge_plain,
              rp_id, origin, session_token, created_at, expires_at, flow
         FROM passkey_qr_sessions
        WHERE session_id = ? AND flow = 'login'`
    )
    .bind(sessionId)
    .first();
  return row || null;
}

/** 绑定手机端 challenge（只允许 pending 且未过期）。 */
export async function setQrChallenge(d1, sessionId, { challengeHash, challengePlain }) {
  const res = await d1
    .prepare(
      `UPDATE passkey_qr_sessions SET challenge_hash = ?, challenge_plain = ?
        WHERE session_id = ? AND flow = 'login' AND status = 'pending' AND expires_at > ?`
    )
    .bind(challengeHash, challengePlain, sessionId, Date.now())
    .run();
  return Number(res && res.meta ? res.meta.changes : 0) > 0;
}

/**
 * 原子提交（挑战已验签通过）：
 *   1) 凭据 signCount CAS 更新（防并发回退）
 *   2) 写 auth_sessions（token_hash = SHA-256(明文)，标准会话表）
 *   3) qr 会话置 success 并暂存一次性明文 token
 * 任一步不成立 → 调用方负责补偿（见 rollbackQrSession）。
 */
export async function completeQrSession(
  d1,
  {
    sessionId,
    credentialId,
    storedSignCount,
    newSignCount,
    backedUp,
    userVerified,
    userKey,
    userUuid,
    sessionToken,
    sessionTokenHash,
    sessionTtlMs,
  }
) {
  const now = Date.now();
  const ttl = Math.max(1000, sessionTtlMs | 0);
  const expiresAt = now + ttl;

  const cas = await d1
    .prepare(
      `UPDATE passkey_credentials SET sign_count = ?, last_used_at = ?, backed_up = ?, user_verified = ?
        WHERE credential_id = ? AND sign_count = ? AND status = 'active'`
    )
    .bind(
      newSignCount | 0,
      now,
      backedUp ? 1 : 0,
      userVerified ? 1 : 0,
      credentialId,
      storedSignCount | 0
    )
    .run();
  const credentialUpdated = Number(cas && cas.meta ? cas.meta.changes : 0) > 0;
  if (!credentialUpdated) {
    return { credentialUpdated: false, sessionInserted: false, sessionCompleted: false, expiresAt };
  }

  const mark = d1
    .prepare(
      `UPDATE passkey_qr_sessions
          SET status = 'success', user_key = ?, user_uuid = ?,
              challenge_hash = NULL, challenge_plain = NULL, session_token = ?
        WHERE session_id = ? AND flow = 'login' AND status = 'pending' AND expires_at > ?`
    )
    .bind(userKey, userUuid || "", sessionToken, sessionId, now);
  const insertSession = d1
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_key, user_uuid, auth_method, mfa_level, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, 'session', 1, ?, ?, ?)`
    )
    .bind(sessionTokenHash, userKey, userUuid || "", now, now, expiresAt);

  const results = await d1.batch([mark, insertSession]);
  const changes = (i) => {
    const m = results && results[i] && results[i].meta ? results[i].meta : {};
    return Number(m.changes) || 0;
  };
  return {
    credentialUpdated: true,
    sessionCompleted: changes(0) > 0,
    sessionInserted: changes(1) > 0,
    expiresAt,
  };
}

/** 补偿：会话行已写但 qr 行未置成功时，撤销刚写的会话，避免留下野会话。 */
export async function rollbackQrSession(d1, { sessionId, sessionTokenHash }) {
  try {
    await d1
      .prepare(`DELETE FROM auth_sessions WHERE token_hash = ? AND auth_method = 'session'`)
      .bind(sessionTokenHash)
      .run();
  } catch (e) {}
  try {
    await d1
      .prepare(
        `UPDATE passkey_qr_sessions SET status = 'pending', session_token = NULL
          WHERE session_id = ? AND status = 'success' AND session_token IS NULL`
      )
      .bind(sessionId)
      .run();
  } catch (e) {}
}

/**
 * 一次性取件：先 CAS 清空 session_token，再返回明文。
 * 并发 claim 只有一个能拿到（第二个 CAS 失败 → 409）。
 */
export async function claimQrSession(d1, sessionId) {
  const row = await findQrSession(d1, sessionId);
  if (!row) return { ok: false, reason: "unknown" };
  if (Date.now() > Number(row.expires_at)) return { ok: false, reason: "expired" };
  if (String(row.status) !== "success") return { ok: false, reason: "not_ready" };
  const token = String(row.session_token || "");
  if (!token) return { ok: false, reason: "delivered" };
  const res = await d1
    .prepare(
      `UPDATE passkey_qr_sessions SET session_token = NULL
        WHERE session_id = ? AND flow = 'login' AND status = 'success' AND session_token = ?`
    )
    .bind(sessionId, token)
    .run();
  if (!(Number(res && res.meta ? res.meta.changes : 0) > 0)) {
    return { ok: false, reason: "delivered" };
  }
  return {
    ok: true,
    sessionToken: token,
    userKey: String(row.user_key || ""),
    userUuid: String(row.user_uuid || ""),
  };
}

/** 惰性清理过期行（init 时顺手调用，失败不影响主流程）。 */
export async function cleanupExpiredQrSessions(d1) {
  try {
    await d1
      .prepare(`DELETE FROM passkey_qr_sessions WHERE expires_at < ?`)
      .bind(Date.now() - 60000)
      .run();
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 扫码注册（flow='register'）：电脑出码，手机上 create，私钥在手机      */
/*                                                                     */
/* 身份来源：桌面端发起时的登录态（会话 / reauth / 站点 auth-token）， */
/* 由桌面预写入 user_key/user_uuid；手机端不提供也不被信任任何身份。   */
/* ------------------------------------------------------------------ */

/**
 * 建一条扫码注册会话：flow='register'，user_key 预先写入（来自桌面登录态）。
 * 需要先执行 migrations/0007_passkey_qr_register.sql。
 */
export async function insertQrRegisterSession(
  d1,
  { sessionId, rpId, origin, userKey, userUuid, ttlMs }
) {
  const now = Date.now();
  const expiresAt = now + Math.max(1000, Math.min(QR_SESSION_MAX_TTL_MS, ttlMs | 0));
  await d1
    .prepare(
      `INSERT INTO passkey_qr_sessions (
         session_id, status, user_key, user_uuid, challenge_hash, challenge_plain,
         rp_id, origin, session_token, created_at, expires_at, flow)
       VALUES (?, 'pending', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, 'register')`
    )
    .bind(sessionId, userKey, userUuid || "", rpId, origin, now, expiresAt)
    .run();
  return { createdAt: now, expiresAt };
}

/** 只取扫码注册会话（flow 必须是 register）；登录流程的会话一律返回 null。 */
export async function findQrRegisterSession(d1, sessionId) {
  const row = await d1
    .prepare(
      `SELECT session_id, status, user_key, user_uuid, challenge_hash, challenge_plain,
              rp_id, origin, session_token, created_at, expires_at, flow
         FROM passkey_qr_sessions
        WHERE session_id = ?`
    )
    .bind(sessionId)
    .first();
  if (!row) return null;
  if (String(row.flow || "login") !== "register") return null;
  return row;
}
