-- hzdv D1 passkey 阶段1+2 migration
-- Phase 1 基础设施：auth_sessions / passkey_challenges / passkey_credentials
-- Phase 2 注册容量：passkey_credentials 为权威凭据存储
-- 说明：D1 为权威存储；KV 仅保留用户主记录。手机号不落明文；
--       challenge 与 session/reauth token 存 SHA-256，credential_id / public_key 明文。
-- 执行（仅限本地/测试 D1，禁止对生产 D1/KV 写）：
--   npx wrangler d1 execute <DB> --local --file=migrations/0005_passkey.sql
--   # 或远程测试库：--remote（不在本任务范围内）

-- =====================================================================
-- 1) 服务端会话 / reauth 票据 / 一次性 grant 统一表
--    token_hash = SHA-256(token)。reauth 票据与一次性邮箱码也复用本表，
--    auth_method 区分 growth：'session' / 'reauth' / 'email_code'。
--    消费一次性 grant（reauth/email_code）用 DELETE（严格一次性）；
--    长期会话用 revoked_at 软撤销。
-- =====================================================================
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash    TEXT PRIMARY KEY,
  user_key      TEXT NOT NULL,           -- phone:<digits> 逻辑键（对应 KV 用户主记录）
  user_uuid     TEXT NOT NULL DEFAULT '',-- KV 用户主记录内的 uuid
  auth_method   TEXT NOT NULL CHECK (auth_method IN ('session','reauth','email_code')),
  mfa_level     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,        -- Unix 毫秒
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions (user_key, revoked_at);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions (expires_at);

-- =====================================================================
-- 2) 注册/登录 ceremony challenge（一次性，TTL 300s）
--    仅存 SHA-256(challenge)，不存原 challenge。验签成功后原子删除。
-- =====================================================================
CREATE TABLE IF NOT EXISTS passkey_challenges (
  ceremony_id           TEXT PRIMARY KEY,
  challenge_hash        TEXT NOT NULL UNIQUE,
  flow                  TEXT NOT NULL CHECK (flow IN ('register','authenticate')),
  user_key              TEXT,
  allowed_credential_ids TEXT NOT NULL DEFAULT '[]',
  rp_id                 TEXT NOT NULL,
  origin                TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry
  ON passkey_challenges (expires_at);

-- =====================================================================
-- 3) 注册凭据（权威）：credential_id 全局 UNIQUE，服务端绝对映射。
--    signCount CAS 更新；撤销软删（保留审计)。
-- =====================================================================
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key          TEXT NOT NULL,
  user_uuid         TEXT NOT NULL DEFAULT '',
  credential_id     TEXT NOT NULL UNIQUE,   -- 原始 credential ID 的 base64url（无填充），UNIQUE
  public_key_cose   TEXT NOT NULL,          -- COSE_Key 原始字节，base64url
  algorithm         INTEGER NOT NULL,       -- COSE alg 整数：ES256=-7, EdDSA=-8, RS256=-257
  sign_count        INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports        TEXT NOT NULL DEFAULT '[]',
  aaguid            TEXT NOT NULL DEFAULT '',
  backup_eligible   INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0,1)),
  backed_up         INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0,1)),
  user_verified     INTEGER NOT NULL DEFAULT 0 CHECK (user_verified IN (0,1)),
  attestation_format TEXT NOT NULL DEFAULT 'none',
  attestation_type   TEXT NOT NULL DEFAULT '',
  credential_device_type TEXT NOT NULL DEFAULT '',
  credential_protection_policy TEXT NOT NULL DEFAULT '',
  rp_id             TEXT NOT NULL,
  origin            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  label             TEXT NOT NULL DEFAULT '',
  revoked_at        INTEGER,
  -- BE=0 时 BS 必须为 0（非法组合拒绝）
  CHECK (backup_eligible = 1 OR backed_up = 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id
  ON passkey_credentials (credential_id);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_status
  ON passkey_credentials (user_key, status);