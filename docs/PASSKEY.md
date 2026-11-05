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

---

## 阶段3：登录（assertion）

本轮新增登录端点，进入主站的身份证明。

### 新增文件

| 文件 | 作用 |
| --- | --- |
| `functions/api/passkey/authenticate/options.js` | `POST /api/passkey/authenticate/options`：生成 `flow='authenticate'` challenge；带 `phone`（可选）时 allowCredentials 收敛为该用户 active 凭据；无 phone 为 discoverable 模式；用户不存在/凭据为空返回同构 options（不枚举） |
| `functions/api/passkey/authenticate/verify.js` | `POST /api/passkey/authenticate/verify`：`verifyAuthenticationResponse` 验签 → signCount CAS 更新 → 新建 `auth_session` → 返回 session token（明文只此一次，库里存 SHA-256） |
| `functions/lib/passkey-d1.js`（增） | `loginAtomic()`：D1 `batch` 原子「消费 challenge + signCount 条件 UPDATE(CAS) + 写 auth_session」，任一失败整批回滚 |
| `functions/lib/passkey-config.js`（增） | `sessionTtlMs()`：登录会话 TTL（`PASSKEY_SESSION_TTL_MS`，默认 7 天） |
| `docs/PASSKEY.md` | 本文件 |
| `scripts/passkey/assertion.test.mjs` | 登录集成测试（E2–E7） |

### request / response

`POST /api/passkey/authenticate/options`
- body `{ phone?: string }`
- → `{ ok:true, ceremonyId, publicKey:{ challenge, rpId:'hzdv.net', userVerification:'preferred', allowCredentials?:[...] } }`

`POST /api/passkey/authenticate/verify`
- body `{ ceremonyId, credential:{ id, rawId, type, response:{ clientDataJSON, authenticatorData, signature, userHandle? } } }`
- → `{ ok:true, authMethod:'passkey', sessionToken, expiresAt, user }`
- `sessionToken` 明文只在本次响应返回；落库为 `SHA-256(token)` 存 `auth_sessions(token_hash, auth_method='session')`。

### 安全（阶段3 hard_rules 对照）

- **身份服务端反查**：只认 `credentialId` → `findActiveCredentialById`（active 且绝对映射），绝不采信客户端 user id / phone / uuid。
- **防枚举**：未知 credentialId 与签名失败返回**完全相同的模糊响应**（同 status + 同 body）。
- **challenge**：只存 SHA-256、300s TTL、验签成功后 D1 batch 原子 `DELETE` 一次性消费；重复提交被拒。
- **校验**：`clientDataJSON.type=='webauthn.get'`、challenge 一致、origin 白名单、rpIdHash==SHA256('hzdv.net')、UP=true；BE=0/BS=1 拒绝；BE 与注册时一致。
- **signCount 策略**：`signCount=0` 视为同步 passkey，跳过递增校验（连续登录不误锁）；`signCount>0` 必须严格递增（库内 + `UPDATE ... WHERE sign_count=旧值` 的 CAS 双重校验，并发只有一个成功）。
- **会话**：TTL 由调用方显式给出（`sessionTtlMs`）写 `expires_at`；仅 active 凭据可登录（`status='revoked'` 拒绝）。
- **灰度**：所有新增逻辑由 `PASSKEY_ENABLED=false`（默认）包裹；不清生产 D1/KV、不部署生产。

### 阶段3 新增/变更环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PASSKEY_SESSION_TTL_MS` | 否 | 登录会话 TTL（毫秒），默认 `604800000`（7 天），写入 `auth_sessions.expires_at`，不允许无过期 |

### 登录集成测试（`scripts/passkey/assertion.test.mjs`）覆盖

- E2 完整 assertion ceremony：options → verify 返回 session token，`auth_sessions` 出现 `auth_method='session'` 行
- E3 同一 assertion 重放第二次被拒（一次性消费）
- E4 signCount=0 同步 passkey 连续两次登录都成功（不误锁）
- E5 signCount>0 用回退旧值提交被拒（克隆检测）
- E6 未知 credentialId 与签名失败返回完全相同模糊响应
- E7 signCount CAS 并发：同一凭据两个并发 verify 仅一个成功

### 遗留（阶段3）

登录端点在真实浏览器（iOS/Android/Windows/macOS）与真实 Pages 预览分支的 smoke、浏览器矩阵，以及登录页 UI（前端）仍需在后续轮完成；生产开启 `PASSKEY_ENABLED` 前需完成上述验证。