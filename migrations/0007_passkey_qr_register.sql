-- hzdv D1：扫码注册通行密钥（私钥在手机）
--
-- 目的：passkey_qr_sessions 同时承载两种扫码流程，用 flow 区分：
--   'login'    —— 现有跨设备扫码登录（qr/init|challenge|verify|claim|poll），行为不变
--   'register' —— 扫码注册：电脑出码、手机上 create，私钥留在手机
--
-- 执行（生产前必须先备份；本脚本只加列，不动既有行）：
--   wrangler d1 execute <生产库> --remote --file=migrations/0007_passkey_qr_register.sql
--
-- 幂等说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
--   重复执行会报 "duplicate column name: flow"（无害）。
--   执行前可先确认是否已有该列：
--     SELECT sql FROM sqlite_master WHERE type='table' AND name='passkey_qr_sessions';
--     PRAGMA table_info(passkey_qr_sessions);
--
-- 既有行一律补 'login'（DEFAULT），不改变既有扫码登录会话的语义。

ALTER TABLE passkey_qr_sessions
  ADD COLUMN flow TEXT NOT NULL DEFAULT 'login' CHECK (flow IN ('login', 'register'));
