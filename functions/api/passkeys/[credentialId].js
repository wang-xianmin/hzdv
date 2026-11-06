/**
 * DELETE /api/passkeys/:credentialId
 * 撤销一把 passkey（软删，保留审计）。需要有效会话或 reauth 票据，且凭据必须属于当前用户。
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