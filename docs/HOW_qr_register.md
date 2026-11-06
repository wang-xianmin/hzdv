# HOW：扫码注册通行密钥（私钥在手机）— Coordinator 拍板

## 产品（已确认）
1. 个人资料点「注册通行密钥」→ **电脑出二维码**（默认不再本机 create）
2. 手机扫码 → 落地页在**手机**上 `navigator.credentials.create` → 私钥在手机
3. 公钥+credential_id 写入 D1，挂当前登录账号
4. 日后任意电脑「通行密钥」登录码 → 同手机扫码登录（现有 login QR 流程）

## 禁止
二维码/URL 携带私钥；不信任手机请求体里的 phone。

## 方案（自建扫码注册，对齐现有 login QR）
### D1
- `migrations/0007_passkey_qr_register.sql`：`passkey_qr_sessions` 增加 `flow TEXT NOT NULL DEFAULT 'login' CHECK (flow IN ('login','register'))`
- register init 时写入 `flow='register'` 且 **预先写入** `user_key`（来自桌面 auth-token）

### API（/tmp/hzdv-passkey-deploy）
- `POST /api/passkey/qr/register/init`：requireAuth/桥接 auth-token；insert 会话；返回 `{session_id, qr_url: origin+/passkey/register-scan?sid=, expires_at}`
- `GET /api/passkey/qr/register/poll?sid=`：桌面轮询；success 当凭据已写入（或 status=success）
- `POST /api/passkey/qr/register/options?sid=`：校验 sid+flow=register+pending；按会话 user_key 发 create options（勿用请求体身份）
- `POST /api/passkey/qr/register/verify?sid=`：校验 attestation；`insertCredential` 绑会话 user_key；会话 → success
- 现有 login `qr/init|challenge|verify|claim|poll` **行为不变**

### 前端
- `functions/passkey/register-scan.js`（或同目录页）：手机落地，自动/按钮触发 create→verify
- `lib/user/profile.js`：注册按钮改为出码+轮询（对标 wxu）；成功 `SetLabel(true)`；可选次要链接「使用本机注册」调用旧 `mgr.register`（建议保留为次要）
- 自绘 QR：复用 login 侧 `qrcode` vendor（与 passkey-qr.js 相同）

### 验收
1. 电脑已登录 → 资料 → 注册 → 出码
2. 手机扫码 → 系统创建通行密钥
3. 电脑字段变 `passkey...`，D1 有 credential
4. 换电脑打开通行密钥登录码 → 同手机可登录
5. 未登录不能 init register

工作区：/tmp/hzdv-passkey-deploy；完成后本地 commit；**git push** 部署，禁止 wrangler 直传生产。
