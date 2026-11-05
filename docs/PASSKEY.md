# HZDV Passkey 阶段1+2 落地说明（RP ID 固定 hzdv.net）

> 本轮只做 **服务端会话/reauth 基础 + 注册（attestation）**，**不做登录（assertion）端
> 点、不改前端页面、不部署生产**。默认 `PASSKEY_ENABLED=false` 灰度关闭。

## 新增/改动文件（本轮）

| 文件 | 作用 |
| --- | --- |
| `migrations/0005_passkey.sql` | D1 三表：`auth_sessions` / `passkey_challenges` / `passkey_credentials`（含索引与 CHECK 约束） |
| `functions/lib/passkey-config.js` | 安全配置解析（灰度开关 / RP ID / 白名单 / TTL） |
| `functions/lib/passkey-crypto.js` | base64url / SHA-256 / HMAC / 认证器 flags 解析 |
| `functions/lib/passkey-d1.js` | D1 权威存储访问（会话/challenge/凭据；原子一次性消费） |
| `functions/lib/passkey-auth.js` | reauth 票据（HMAC+nonce 一次性）、会话、邮箱一次性码 |
| `functions/lib/passkey-resp.js` | 统一模糊 JSON 响应 |
| `functions/lib/passkey-rate.js` | 基础（粗粒度）限速，KV best-effort |
| `functions/api/passkey/reauth.js` | `POST /api/passkey/reauth`（密码 / 邮箱一次性码） |
| `functions/api/passkey/register/options.js` | `POST /api/passkey/register/options` |
| `functions/api/passkey/register/verify.js` | `POST /api/passkey/register/verify` |
| `functions/api/passkeys/index.js` | `GET /api/passkeys`（列表） |
| `functions/api/passkeys/[credentialId].js` | `DELETE /api/passkeys/:credentialId`（撤销） |
| `package.json` / `package-lock.json` | 固定 `@simplewebauthn/server@14.0.3` + `wrangler`，Pages Functions 可 `npm ci` 构建 |
| `docs/PASSKEY.md` | 本文件 |
| `scripts/passkey/commitment.test.mjs` | 集成测试（测试向量），覆盖一次性消费 / origin / rpId 拒绝 |

## 环境变量清单（只写文档，生产 secret 由 Cloudflare 面板/私密配置注入）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PASSKEY_ENABLED` | 否 | `true`/`false`，灰度开关，默认 `false`（本轮默认关闭） |
| `PASSKEY_RP_ID` | 否 | 固定 `hzdv.net`（注册域名；改成子域会让既有 passkey 失效，勿改） |
| `PASSKEY_RP_NAME` | 否 | 展示名，默认 `HZDV` |
| `PASSKEY_ALLOWED_ORIGINS` | 否 | 显式白名单，逗号分隔，精确 origin，如 `https://hzdv.net,https://www.hzdv.net`；禁止通配符 |
| `PASSKEY_REAUTH_TTL_MS` | 否 | reauth 票据 TTL，默认 `300000`（5 分钟） |
| `PASSKEY_CHALLENGE_TTL_MS` | 否 | challenge TTL，默认 `300000`（5 分钟） |
| `HMAC_SECRET` | 是 | 已有；reauth 票据签名 + nonce 一次性绑定（与 KV 用户主记录复用） |
| `ENCRYPTION_KEY` | 是 | 已有；reauth 密码/邮箱分支读 KV 用户主记录需要 |
| D1 绑定 `hzdvd1` | 是 | 权威存储（三表）；`pickD1Binding` 也兼容 `DV_D1`/`DB` 等 |
| KV 绑定 `dv_kv` | 是 | reauth 密码/邮箱分支读用户主记录用的 KV；限速用 |

> 生产部署：D1 migration 只能在**本地/测试 D1** 执行，禁止对生产 D1/KV 写。
> 本任务不申请生产 secret、不执行 `wrangler pages deploy`。

## 安全模型（hard_rules 对照）

- **权威存储**：passkey 凭据 / challenge / 会话 / reauth 的一次性 nonce 都在 D1；
  KV 只保留用户主记录，passkey 不嵌入 `USERS_KV`。
- **信任边界**：注册前必须有服务端可验证身份（有效 `auth_sessions` 会话 或
  reauth 票据）；**绝不信任 localStorage 里的 phone/uuid**。
- **加密存储**：challenge 与 session/reauth token 存 SHA-256；`credential_id`/`public_key` 明文。
- **一次性消费**：challenge 验签成功用 D1 `batch` 原子 `DELETE`；重复提交同一 challenge 被拒。
- **绝对映射**：`credential_id` 全局 `UNIQUE`，服务端维护 `credential_id → user_key`；
  任何情况不采信客户端提交的 user id。
- **origin**：显式白名单 `https://hzdv.net`、`https://www.hzdv.net`；禁通配符、禁只信请求
  Origin。RP ID 固定 `hzdv.net`。
- **flags**：校验 `clientDataJSON.type=='webauthn.create'`、challenge 一致、
  `origin` 白名单、`authenticatorData.rpIdHash==SHA256('hzdv.net')`、UP=true；
  UV 落库但不强制 required；BE=0/BS=1 拒绝。
- **错误模糊化**：统一 `Passkey operation could not be completed`，不区分用户不存在/未注册
  passkey；注册/reauth 接口加基础限速。
- **回退策略**：passkey 失败不自动降级；用户显式选择密码/邮箱/扫码。

## 已知边界 / 遗留

- **登录（assertion）端点本轮不做**：`authenticate/options`、`authenticate/verify` 未实现，
  `@simplewebauthn/server` 的 generateAuthenticationOptions/verifyAuthenticationResponse 未接线。
- **reauth 邮箱分支的一次性码**：写入 D1（`auth_method='email_code'`，只存 SHA-256）并
  消费即删；「发送验证码」的邮件发送端点（复用 `send-email-code` 基础设施）属后续增量，
  本轮只提供 `issueEmailReauthCode` 供接线/测试，前端管理页下一轮。
- **前端**未改；管理页 UI 下轮。
- **长会话** `createAuthSession` 已实现但本轮没有产生它的登录路径；本轮可用 reauth 票据
  作为身份完成注册。
- 撤销最后一把凭据需「近期 reauth」的策略点已预留，本轮未强制（前端下轮接入后再收紧）。

## 如何验证（见 `scripts/passkey/commitment.test.mjs`）

1. `npm ci`
2. `npm run dev`（wrangler pages dev，见启动日志）
3. `node scripts/passkey/commitment.test.mjs` —— 覆盖：
   - options→verify 完整注册通过（测试向量：构造 `fmt: none` attestation，密钥对由
     WebCrypto ES256 生成）
   - 重复提交同一 challenge（同 ceremony / 同 credential）被拒
   - origin 不在白名单被拒
   - rpId 不匹配被拒