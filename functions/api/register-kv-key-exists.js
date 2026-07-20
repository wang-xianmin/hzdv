/**
 * 查询 KV 中是否已存在某 key：GET /api/register-kv-key-exists?key=phone%3A13800138000
 */
import { assertPhoneKey } from "../lib/kv-secure.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key || typeof key !== "string") {
    return jsonResponse({ success: false, error: "Missing key" }, 400);
  }
  try {
    assertPhoneKey(key);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e.message || e) }, 400);
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
    const v = await kv.get(key);
    return jsonResponse({ success: true, exists: v != null });
  } catch (e) {
    console.error("register-kv-key-exists:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
