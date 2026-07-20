import {
  rebuildAllGroupIndexes,
  rebuildGroupIndexesForGroup,
} from "../lib/group-index.js";
import { kvBindingHint, pickKvBinding } from "../lib/kv-binding.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim()) body = JSON.parse(text);
    } catch {
      body = {};
    }
    const groupRaw = body && body.group != null ? String(body.group).trim() : "";
    const result = groupRaw
      ? await rebuildGroupIndexesForGroup(kv, env, groupRaw)
      : await rebuildAllGroupIndexes(kv, env);
    return jsonResponse({ success: true, ...result });
  } catch (e) {
    console.error("rebuild-group-index:", e);
    return jsonResponse(
      { success: false, error: String(e.message || e) },
      500
    );
  }
}
