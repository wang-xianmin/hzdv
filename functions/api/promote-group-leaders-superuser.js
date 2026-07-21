/**
 * 一次性维护：将所有「组长」(value.g_role === 1) 的 metadata 打上超级用户位
 * （与 check-user.js 中 typeMask & 1 一致）。
 *
 * POST /api/promote-group-leaders-superuser
 * 鉴权（fail-closed）：
 *   - Pages 环境变量 MAINTENANCE_SECRET 必须已配置
 *   - 请求头 X-Maintenance-Secret 或 JSON body.secret 须与之匹配
 *   - JSON body.confirm 必须为 true
 * Body 示例：{ "confirm": true, "secret": "..." }
 * 完成后请自行在用户列表中改回不需要的账号。
 */
import {
  listKvUserStorageKeys,
  readKvUserByStorageKey,
  writeKvUser,
} from "../lib/kv-secure.js";
import { getPhoneFromPhoneKey } from "../lib/group-index.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqualString(a, b) {
  const sa = String(a == null ? "" : a);
  const sb = String(b == null ? "" : b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

/** @returns {{ m: number, width: number, binary: boolean }} */
function parseTypeField(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return { m: 0, width: 8, binary: true };
  if (/^[01]+$/.test(t)) {
    return { m: parseInt(t, 2) || 0, width: t.length, binary: true };
  }
  return { m: parseInt(t, 10) || 0, width: 8, binary: false };
}

function formatTypeField({ m, width, binary }) {
  const mm = (m | 1) >>> 0;
  if (binary) {
    const bits = mm.toString(2);
    const pad = Math.max(width, bits.length);
    return bits.padStart(pad, "0").slice(-pad);
  }
  return String(mm);
}

function metadataWithSuperBit(meta) {
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  const typeStr =
    m.type != null && String(m.type) !== ""
      ? String(m.type)
      : m.uA != null && String(m.uA) !== ""
        ? String(m.uA)
        : "00010000";
  const parsed = parseTypeField(typeStr);
  const next = formatTypeField(parsed);
  m.type = next;
  m.uA = next;
  return m;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const configuredSecret = String(
    (env && (env.MAINTENANCE_SECRET || env.KV_MAINTENANCE_SECRET)) || ""
  ).trim();
  if (!configuredSecret) {
    return jsonResponse(
      {
        success: false,
        error: "Maintenance endpoint disabled",
        hint: "请在 Pages 配置环境变量 MAINTENANCE_SECRET 后再调用。",
      },
      503
    );
  }

  let body = {};
  try {
    const text = await request.text();
    if (text && text.trim()) body = JSON.parse(text);
  } catch {
    body = {};
  }

  const providedSecret = String(
    request.headers.get("X-Maintenance-Secret") ||
      (body && body.secret) ||
      ""
  ).trim();
  if (!providedSecret || !timingSafeEqualString(providedSecret, configuredSecret)) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }
  if (!(body && body.confirm === true)) {
    return jsonResponse(
      {
        success: false,
        error: "confirm required",
        hint: '请在 JSON body 中传 "confirm": true',
      },
      400
    );
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
    const storageKeys = await listKvUserStorageKeys(kv);
    const seen = new Set();

    let scanned = 0;
    let leaders = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const sk of storageKeys) {
      scanned++;
      try {
        const row = await readKvUserByStorageKey(kv, env, sk);
        if (!row || !row.value) {
          skipped++;
          continue;
        }
        const logicalKey = row.logicalKey;
        if (!logicalKey || seen.has(logicalKey)) {
          skipped++;
          continue;
        }
        seen.add(logicalKey);
        const phone = getPhoneFromPhoneKey(logicalKey);
        if (!phone) {
          skipped++;
          continue;
        }
        const gRole = Number(row.value.g_role);
        if (gRole !== 1) {
          skipped++;
          continue;
        }
        leaders++;
        const nextMeta = metadataWithSuperBit(row.metadata || {});
        await writeKvUser(kv, env, logicalKey, row.value, nextMeta);
        updated++;
      } catch (e) {
        skipped++;
        errors.push({ key: sk, error: String(e && (e.message || e)) });
      }
    }

    return jsonResponse({
      success: true,
      scanned,
      leaders,
      updated,
      skipped,
      errors,
      hint: "组长已全部打上超级用户位；请在用户列表中自行改回不需要的账号。",
    });
  } catch (e) {
    console.error("promote-group-leaders-superuser:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
