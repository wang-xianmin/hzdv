/**
 * DELETE /api/passkeys/:credentialId
 * 撤销一把 passkey（软删，保留审计）。需要可验证身份（passkey 会话 / reauth 票据 /
 * 站点登录态），且凭据必须属于当前用户。
 */

import { passkeyEnabled } from "../../lib/passkey-config.js";
import { pickD1, revokeCredential, findActiveCredentialById } from "../../lib/passkey-d1.js";
import { resolveIdentity } from "../../lib/passkey-auth.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  unauthorized,
  fail,
} from "../../lib/passkey-resp.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method !== "DELETE") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  // 撤销票据优先走请求头：DELETE 带 body 会被部分 CDN/WAF 丢弃。
  // body.reauthToken 仅保留为兼容回退。
  const headerToken = String(request.headers.get("x-reauth-token") || "").trim();
  if (headerToken) {
    body = Object.assign({}, body, { reauthToken: headerToken });
  }

  // 撤销身份：passkey 会话 / reauth 票据 / 站点登录态（hz_auth Cookie）均可，
  // 与 list / register 保持一致（它们默认都允许站点 token 兜底）。
  // 个人资料已登录时可直接撤销服务端凭据记录；客户端仍会提示用户
  // 同步删除手机上的 hzdv.net 私钥（见 passkey-ui.js 的 confirm 文案）。
  const identity = await resolveIdentity(env, d1, request, body);
  if (!identity) return unauthorized();

  const credentialId = (params && params.credentialId) || "";
  if (!credentialId) return fail(400);

  try {
    const row = await findActiveCredentialById(d1, credentialId);
    if (!row || String(row.user_key) !== identity.userKey) return fail(404);
    const ok = await revokeCredential(d1, identity.userKey, credentialId);
    if (!ok) return fail(409);
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("[passkeys revoke]", e);
    return fail(400);
  }
}