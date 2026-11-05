/**
 * GET /api/passkeys
 * 列出当前用户的 passkey 凭据（需要有效会话或 reauth 票据）。
 * 前端管理页可以下一轮；本函数只暴露最小安全列表服务端能力。
 */

import { passkeyEnabled } from "../../lib/passkey-config.js";
import { pickD1, findUserActiveCredentials } from "../../lib/passkey-d1.js";
import { resolveIdentity } from "../../lib/passkey-auth.js";
import {
  jsonResponse,
  methodNotAllowed,
  disabled,
  notConfigured,
  unauthorized,
} from "../../lib/passkey-resp.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") return methodNotAllowed();
  if (!passkeyEnabled(env)) return disabled();

  const d1 = pickD1(env);
  if (!d1) return notConfigured();

  const identity = await resolveIdentity(env, d1, request, {});
  if (!identity) return unauthorized();

  try {
    const rows = await findUserActiveCredentials(d1, identity.userKey);
    const credentials = rows.map((c) => ({
      id: c.credential_id,
      name: c.label || "",
      createdAt: Number(c.created_at) || 0,
      lastUsedAt: c.last_used_at != null ? Number(c.last_used_at) : null,
      backupEligible: c.backup_eligible ? 1 : 0,
      backedUp: c.backed_up ? 1 : 0,
      deviceType: c.credential_device_type || "",
      algorithm: Number(c.algorithm) || 0,
      transports: JSON.parse(c.transports || "[]"),
    }));
    return jsonResponse({ ok: true, credentials });
  } catch (e) {
    console.error("[passkeys list]", e);
    return jsonResponse({ ok: false, error: "Passkey operation could not be completed" }, 400);
  }
}