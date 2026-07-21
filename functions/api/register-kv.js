/**
 * 新人注册写入 KV：POST /api/register-kv
 * Body: { key, value, metadata, turnstileToken? }
 * 默认须通过 Turnstile（与 verify-turnstile 同源 siteverify）；
 * Pages 环境变量：TURNSTILE_SECRET_KEY；可选 REGISTER_KV_SKIP_TURNSTILE=1/true/yes 跳过校验（仅本地排错）。
 * KV：仅写 uk:+HMAC（禁止新用户写明文 phone:）；ENCRYPTION_KEY / HMAC_SECRET 缺失 fail-closed。
 */
import { assertPhoneKey, readKvUser, writeKvUser } from "../lib/kv-secure.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
import {
  getPhoneFromPhoneKey,
  upsertUserGroupIndex,
} from "../lib/group-index.js";
import {
  normalizeSixDigitsFromStored,
  readInviteCodeFromKv,
  sanitizeGroupForInvite,
} from "../lib/group-invite-kv.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function verifyTurnstileWithEnv(env, token) {
  if (!token) {
    return { ok: false, error: "Missing turnstileToken" };
  }
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    return {
      ok: false,
      error: "TURNSTILE_SECRET_KEY not configured",
      httpStatus: 503,
    };
  }
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  let result;
  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    result = await r.json();
  } catch (e) {
    return { ok: false, error: "siteverify failed", detail: String(e) };
  }
  if (!result.success) {
    return { ok: false, error: "Turnstile verification failed", result };
  }
  return { ok: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse(
      {
        success: false,
        error: "KV not configured",
        hint: kvBindingHint(),
      },
      503
    );
  }
  try {
    const body = await request.json();
    const key = body.key;
    const value = body.value;
    const metadata = body.metadata;
    if (!key || typeof key !== "string") {
      return jsonResponse({ success: false, error: "Missing key" }, 400);
    }
    try {
      assertPhoneKey(key);
    } catch (e) {
      return jsonResponse({ success: false, error: String(e.message || e) }, 400);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      typeof metadata !== "object" ||
      metadata === null
    ) {
      return jsonResponse(
        { success: false, error: "value and metadata must be objects" },
        400
      );
    }

    const skipRaw = String(env.REGISTER_KV_SKIP_TURNSTILE || "").toLowerCase();
    const skipTurnstile = ["1", "true", "yes"].includes(skipRaw);
    if (!skipTurnstile) {
      const tok = body.turnstileToken || body.turnstile_token;
      const vr = await verifyTurnstileWithEnv(env, tok);
      if (!vr.ok) {
        const status = vr.httpStatus || (vr.detail ? 502 : 400);
        return jsonResponse(
          {
            success: false,
            error: vr.error,
            "error-codes": vr.result && vr.result["error-codes"],
            detail: vr.detail,
          },
          status
        );
      }
    }

    const existing = await readKvUser(kv, env, key);
    if (existing != null) {
      return jsonResponse(
        {
          success: false,
          error: "该手机已经注册！",
          code: "ALREADY_EXISTS",
        },
        409
      );
    }

    const grp = sanitizeGroupForInvite(value.group);
    if (grp) {
      const expected = await readInviteCodeFromKv(kv, env, grp);
      if (expected.length === 6) {
        const submitted = normalizeSixDigitsFromStored(
          body.inviteCode != null
            ? body.inviteCode
            : body.invite_code != null
              ? body.invite_code
              : ""
        );
        if (submitted !== expected) {
          return jsonResponse(
            {
              success: false,
              error: "邀请码不正确，请向组长索取「组号(六位数字)」中的六位数字。",
              code: "INVITE_MISMATCH",
            },
            403
          );
        }
      }
    }

    await writeKvUser(kv, env, key, value, metadata);
    let indexSynced = true;
    let indexSyncWarning = "";
    try {
      const phone = getPhoneFromPhoneKey(key);
      if (phone) {
        await upsertUserGroupIndex(kv, env, phone, value);
      }
    } catch (e) {
      indexSynced = false;
      indexSyncWarning = String(e && (e.message || e));
      console.warn("register-kv group-index sync failed:", e);
    }
    return jsonResponse({ success: true, key, index_synced: indexSynced, index_sync_warning: indexSyncWarning });
  } catch (e) {
    console.error("register-kv:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
