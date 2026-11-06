/**
 * Passkey 的 D1 权威存储访问层。
 * 只用 D1（pickD1Binding）。KV 不承载 passkey 权威状态。
 * challenge 只存 SHA-256；token 只存 SHA-256；credential_id/public_key 明文。
 */

import { pickD1Binding } from "./cloudflare-bindings.js";

export function pickD1(env) {
  const d1 = pickD1Binding(env);
  return d1 || null;
}

function notNull(v) {
  return v == null ? null : v;
}

/* ------------------------------------------------------------------ */
/* auth_sessions：session / reauth / email_code grant                  */
/* ------------------------------------------------------------------ */

/** 写入一个 grant（token_hash 为 SHA-256(token)）。auth_method/ttl 由调用方控制。 */
export async function insertAuthGrant(d1, {
  tokenHash,
  userKey,
  userUuid,
  authMethod,
  mfaLevel = 0,
  ttlMs,
}) {
  const now = Date.now();
  const expiresAt = now + Math.max(1000, ttlMs | 0);
  await d1
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_key, user_uuid, auth_method, mfa_level, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(tokenHash, userKey, userUuid || "", authMethod, mfaLevel, now, now, expiresAt)
    .run();
  return { tokenHash, expiresAt };
}

/** 读取一个未撤销、未过期的 grant。 */
export async function findActiveAuthGrant(d1, tokenHash, allowedMethods) {
  const row = await d1
    .prepare(
      `SELECT token_hash, user_key, user_uuid, auth_method, mfa_level, created_at, expires_at, revoked_at
       FROM auth_sessions
       WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.revoked_at != null) return null;
  if (Date.now() > Number(row.expires_at)) return null;
  if (allowedMethods && allowedMethods.indexOf(String(row.auth_method)) === -1) return null;
  return row;
}

/** 消费一次性 grant（reauth / email_code）：删除 = 严格一次性。返回是否成功删除。 */
export async function consumeAuthGrant(d1, tokenHash) {
  const res = await d1
    .prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`)
    .bind(tokenHash)
    .run();
  const changes = res && res.meta ? Number(res.meta.changes) || 0 : 0;
  return changes > 0;
}

/** revoke_at 软撤销（长期 session 用）。 */
export async function revokeAuthGrant(d1, userKey) {
  const res = await d1
    .prepare(
      `UPDATE auth_sessions SET revoked_at = ? WHERE user_key = ? AND revoked_at IS NULL`
    )
    .bind(Date.now(), userKey)
    .run();
  const changes = res && res.meta ? Number(res.meta.changes) || 0 : 0;
  return changes;
}

/* ------------------------------------------------------------------ */
/* passkey_challenges                                                  */
/* ------------------------------------------------------------------ */

export async function insertChallenge(d1, {
  ceremonyId,
  challengeHash,
  flow,
  userKey,
  allowedCredentialIds,
  rp_id,
  origin,
  ttlMs,
}) {
  const now = Date.now();
  const expiresAt = now + Math.max(1000, ttlMs | 0);
  await d1
    .prepare(
      `INSERT INTO passkey_challenges (ceremony_id, challenge_hash, flow, user_key, allowed_credential_ids, rp_id, origin, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ceremonyId,
      challengeHash,
      flow,
      userKey || null,
      JSON.stringify(allowedCredentialIds || []),
      rp_id,
      origin,
      now,
      expiresAt
    )
    .run();
  return { ceremonyId, expiresAt };
}

export async function getChallenge(d1, ceremonyId) {
  return notNull(await d1
    .prepare(
      `SELECT ceremony_id, challenge_hash, flow, user_key, allowed_credential_ids, rp_id, origin, created_at, expires_at
       FROM passkey_challenges WHERE ceremony_id = ?`
    )
    .bind(ceremonyId)
    .first());
}

/** 删除 ceremony（一次性消费）。返回是否删除了一行。 */
export async function deleteChallenge(d1, ceremonyId) {
  const res = await d1
    .prepare(`DELETE FROM passkey_challenges WHERE ceremony_id = ?`)
    .bind(ceremonyId)
    .run();
  const changes = res && res.meta ? Number(res.meta.changes) || 0 : 0;
  return changes > 0;
}

/* ------------------------------------------------------------------ */
/* passkey_credentials                                                 */
/* ------------------------------------------------------------------ */

export async function insertCredential(d1, cred) {
  const res = await d1
    .prepare(
      `INSERT INTO passkey_credentials (
         user_key, user_uuid, credential_id, public_key_cose, algorithm,
         sign_count, transports, aaguid, backup_eligible, backed_up,
         user_verified, attestation_format, attestation_type, credential_device_type,
         rp_id, origin, status, created_at, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      cred.userKey,
      cred.userUuid || "",
      cred.credentialId,
      cred.publicKeyCose,
      cred.algorithm,
      cred.signCount || 0,
      JSON.stringify(cred.transports || []),
      cred.aaguid || "",
      cred.backupEligible ? 1 : 0,
      cred.backedUp ? 1 : 0,
      cred.userVerified ? 1 : 0,
      cred.attestationFormat || "none",
      cred.attestationType || "",
      cred.credentialDeviceType || "",
      cred.rpId,
      cred.origin,
      "active",
      Date.now(),
      cred.label || ""
    )
    .run();
  const lastId = res && res.meta ? Number(res.meta.last_row_id) || null : null;
  return { id: lastId };
}

/**
 * 原子完成扫码注册：仅当 QR 会话仍是 pending/register 时插入 credential，
 * 随后把会话置 success。身份从 session.user_key/user_uuid 读取，不接受调用方传入。
 *
 * INSERT ... SELECT ... WHERE EXISTS 使并发重放只会有一次插入成功；第二次
 * 插入 changes=0，不会遗留额外凭据。
 */
export async function completeQrRegisterSession(d1, { sessionId, credential }) {
  const now = Date.now();
  const insert = d1
    .prepare(
      `INSERT INTO passkey_credentials (
         user_key, user_uuid, credential_id, public_key_cose, algorithm,
         sign_count, transports, aaguid, backup_eligible, backed_up,
         user_verified, attestation_format, attestation_type, credential_device_type,
         rp_id, origin, status, created_at, label)
       SELECT s.user_key, s.user_uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
         FROM passkey_qr_sessions s
        WHERE s.session_id = ? AND s.flow = 'register' AND s.status = 'pending' AND s.expires_at > ?`
    )
    .bind(
      credential.credentialId,
      credential.publicKeyCose,
      credential.algorithm,
      credential.signCount || 0,
      JSON.stringify(credential.transports || []),
      credential.aaguid || "",
      credential.backupEligible ? 1 : 0,
      credential.backedUp ? 1 : 0,
      credential.userVerified ? 1 : 0,
      credential.attestationFormat || "none",
      credential.attestationType || "none",
      credential.credentialDeviceType || "",
      credential.rpId,
      credential.origin,
      now,
      credential.label || "",
      sessionId,
      now
    );
  const complete = d1
    .prepare(
      `UPDATE passkey_qr_sessions
          SET status = 'success', challenge_hash = NULL, challenge_plain = NULL
        WHERE session_id = ? AND flow = 'register' AND status = 'pending' AND expires_at > ?`
    )
    .bind(sessionId, now);

  const results = await d1.batch([insert, complete]);
  const insertMeta = results && results[0] && results[0].meta ? results[0].meta : {};
  const completeMeta = results && results[1] && results[1].meta ? results[1].meta : {};
  return {
    inserted: Number(insertMeta.changes) > 0,
    completed: Number(completeMeta.changes) > 0,
  };
}

/**
 * 原子「消费 ceremony + 插入 credential」。
 * 用 D1 batch 保证一次性：验证成功后才写凭据，且同 ceremony/同 credential 重放会被拒绝。
 * @returns {{ consumed: boolean, inserted: boolean, lastId: number|null }}
 */
export async function consumeAndInsertCredential(d1, ceremonyId, cred) {
  const del = d1
    .prepare(`DELETE FROM passkey_challenges WHERE ceremony_id = ?`)
    .bind(ceremonyId);
  const ins = d1
    .prepare(
      `INSERT INTO passkey_credentials (
         user_key, user_uuid, credential_id, public_key_cose, algorithm,
         sign_count, transports, aaguid, backup_eligible, backed_up,
         user_verified, attestation_format, attestation_type, credential_device_type,
         rp_id, origin, status, created_at, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      cred.userKey,
      cred.userUuid || "",
      cred.credentialId,
      cred.publicKeyCose,
      cred.algorithm,
      cred.signCount || 0,
      JSON.stringify(cred.transports || []),
      cred.aaguid || "",
      cred.backupEligible ? 1 : 0,
      cred.backedUp ? 1 : 0,
      cred.userVerified ? 1 : 0,
      cred.attestationFormat || "none",
      cred.attestationType || "",
      cred.credentialDeviceType || "",
      cred.rpId,
      cred.origin,
      "active",
      Date.now(),
      cred.label || ""
    );
  const results = await d1.batch([del, ins]);
  const delMeta = results && results[0] && results[0].meta ? results[0].meta : {};
  const insRes = results && results[1] ? results[1] : {};
  return {
    consumed: Number(delMeta.changes) > 0,
    inserted: !!(insRes.success === true || (insRes.meta && Number(insRes.meta.last_row_id))),
    lastId:
      insRes.meta && Number(insRes.meta.last_row_id)
        ? Number(insRes.meta.last_row_id)
        : null,
  };
}

export async function findUserActiveCredentials(d1, userKey) {
  const res = await d1
    .prepare(
      `SELECT credential_id, label, public_key_cose, algorithm, sign_count, transports,
              aaguid, backup_eligible, backed_up, user_verified, attestation_format,
              credential_device_type, rp_id, origin, created_at, last_used_at
       FROM passkey_credentials
       WHERE user_key = ? AND status = 'active'
       ORDER BY id ASC`
    )
    .bind(userKey)
    .all();
  return (res && res.results) || [];
}

export async function findActiveCredentialById(d1, credentialId) {
  const res = await d1
    .prepare(
      `SELECT id, user_key, user_uuid, credential_id, public_key_cose, algorithm, sign_count,
              transports, aaguid, backup_eligible, backed_up, user_verified, attestation_format,
              credential_device_type, rp_id, origin, created_at, last_used_at
       FROM passkey_credentials
       WHERE credential_id = ? AND status = 'active'`
    )
    .bind(credentialId)
    .first();
  return notNull(res);
}

export async function countActiveCredentials(d1, userKey) {
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS c FROM passkey_credentials
       WHERE user_key = ? AND status = 'active'`
    )
    .bind(userKey)
    .first();
  return row ? Number(row.c) || 0 : 0;
}

export async function revokeCredential(d1, userKey, credentialId) {
  const res = await d1
    .prepare(
      `UPDATE passkey_credentials SET status = 'revoked', revoked_at = ?
       WHERE credential_id = ? AND user_key = ? AND status = 'active'`
    )
    .bind(Date.now(), credentialId, userKey)
    .run();
  const changes = res && res.meta ? Number(res.meta.changes) || 0 : 0;
  return changes > 0;
}

/**
 * 登录一次性原子提交（D1 batch 保证）：
 *   1) 消费 challenge（DELETE，一次性）
 *   2) signCount 递增 + 更新 last_used_at/backed_up/user_verified（条件 UPDATE = CAS，防并发回退）
 *   3) 写入 auth_session（token_hash 为 sessionTokenHash）
 * 任一失败则整批回滚。
 * @returns {{ challengeConsumed:boolean, credentialUpdated:boolean, sessionInserted:boolean, expiresAt:number }}
 */
export async function loginAtomic(d1, {
  ceremonyId,
  credentialId,
  storedSignCount,
  newSignCount,
  backedUp,
  userVerified,
  userKey,
  userUuid,
  sessionTokenHash,
  sessionTtlMs,
  mfaLevel = 1,
}) {
  const now = Date.now();
  const ttlMs = Math.max(1000, sessionTtlMs | 0);
  const expiresAt = now + ttlMs;
  const delChallenge = d1
    .prepare(`DELETE FROM passkey_challenges WHERE ceremony_id = ?`)
    .bind(ceremonyId);
  const casUpdate = d1
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
    );
  const insertSession = d1
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_key, user_uuid, auth_method, mfa_level, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, 'session', ?, ?, ?, ?)`
    )
    .bind(
      sessionTokenHash,
      userKey,
      userUuid || "",
      mfaLevel,
      now,
      now,
      expiresAt
    );
  const results = await d1.batch([delChallenge, casUpdate, insertSession]);
  const changes = (i) => {
    const m = results && results[i] && results[i].meta ? results[i].meta : {};
    return Number(m.changes) || 0;
  };
  return {
    challengeConsumed: changes(0) > 0,
    credentialUpdated: changes(1) > 0,
    sessionInserted: changes(2) > 0,
    expiresAt,
  };
}