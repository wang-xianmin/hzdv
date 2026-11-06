-- hzdv D1 passkey QR 会话（OpenRouter 式跨设备扫码登录握手区）
-- 身份源仍是 passkey_credentials（credential_id → user_key 绝对映射）；
-- 本表只是临时握手区，TTL <= 5min，session_token 仅用于一次性交接。
-- 严禁修改 passkey_credentials / auth_sessions / passkey_challenges 结构。
-- 执行（仅 preview / 本地 D1，禁止对生产 D1 写）：
--   npx wrangler d1 execute hzdv-passkey-preview --remote --file=migrations/0006_passkey_qr_sessions.sql

-- =====================================================================
-- 1) QR 登录会话
--    session_id: crypto.randomUUID()（UUIDv4，不可枚举）
--    status:     pending（等待手机验证）→ success（手机已验证，待桌面取件）
--    session_token: verify 成功后写入的一次性会话明文；claim 取走时立即置 NULL
-- =====================================================================
CREATE TABLE IF NOT EXISTS passkey_qr_sessions (
  session_id        TEXT PRIMARY KEY,        -- crypto.randomUUID()
  status            TEXT NOT NULL CHECK (status IN ('pending','success','expired')),
  user_key          TEXT,                   -- verify 成功后由 credential_id 反查写入
  user_uuid         TEXT NOT NULL DEFAULT '',
  challenge_hash    TEXT,                   -- 手机端 assertion 的 challenge(SHA-256)，一次性
  challenge_plain   TEXT,                   -- 验签所需的期望 challenge 明文，≤5min
  rp_id             TEXT NOT NULL,
  origin            TEXT NOT NULL,           -- 发起端 origin（须在 PASSKEY_ALLOWED_ORIGINS 内）
  session_token     TEXT,                   -- 一次性交接明文（交付后立即置 NULL）
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkey_qr_sessions_expiry
  ON passkey_qr_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_passkey_qr_sessions_status
  ON passkey_qr_sessions (status, expires_at);
