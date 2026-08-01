/**
 * POST/GET/PUT /api/llm-websearch-refine
 * 运维：联网检索改写规则（关键词 → 英文 query / 域名 / 时间范围）
 *
 * GET  ?admin=1&phone=   列表（需运维）
 * PUT  { phone, rules }  全量保存
 * POST { phone, action, ... }  add|update|delete|move|reset_seed
 */

import {
  pickKvBinding,
  kvBindingHint,
  assertOpsAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import {
  defaultWebsearchRefineSeed,
  loadWebsearchRefineRules,
  normalizeRefineRule,
  reindexRefineOrders,
  saveWebsearchRefineRules,
  sortRefineRules,
} from "../lib/websearch-refine-store.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function phoneOf(request, body) {
  const u = new URL(request.url);
  return (body && body.phone) || u.searchParams.get("phone") || "";
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse(
      { success: false, error: "KV not configured", hint: kvBindingHint() },
      503
    );
  }

  try {
    if (request.method === "GET") {
      await assertOpsAccess(env, phoneOf(request, null));
      const { rules, seeded, updatedAt } = await loadWebsearchRefineRules(kv);
      return jsonResponse({
        success: true,
        rules,
        seeded: !!seeded,
        updatedAt,
      });
    }

    if (request.method === "PUT") {
      const body = await readJson(request);
      if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      await assertOpsAccess(env, phoneOf(request, body));
      const saved = await saveWebsearchRefineRules(kv, body.rules || []);
      return jsonResponse({
        success: true,
        rules: saved.rules,
        updatedAt: saved.updatedAt,
      });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      await assertOpsAccess(env, phoneOf(request, body));
      const action = String(body.action || "").trim();
      const loaded = await loadWebsearchRefineRules(kv);
      let list = loaded.rules.slice();

      if (action === "add" || action === "create") {
        const r = normalizeRefineRule(body.rule || body, list.length);
        if (!r.keywords.length || !r.query) {
          return jsonResponse(
            { success: false, error: "keywords 与 query 必填" },
            400
          );
        }
        r.order =
          list.length === 0 ? 0 : Math.max(...list.map((x) => x.order || 0)) + 1;
        list.push(r);
      } else if (action === "update") {
        const id = String(body.id || (body.rule && body.rule.id) || "").trim();
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) {
          return jsonResponse({ success: false, error: "规则不存在" }, 404);
        }
        const patch = body.rule || body;
        list[idx] = normalizeRefineRule({ ...list[idx], ...patch, id });
      } else if (action === "delete" || action === "remove") {
        const id = String(body.id || "").trim();
        list = list.filter((x) => x.id !== id);
      } else if (action === "move") {
        const id = String(body.id || "").trim();
        const direction = String(body.direction || "").trim();
        list = sortRefineRules(list);
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) {
          return jsonResponse({ success: false, error: "规则不存在" }, 404);
        }
        const swap = direction === "up" ? idx - 1 : direction === "down" ? idx + 1 : -1;
        if (swap < 0 || swap >= list.length) {
          return jsonResponse({ success: true, rules: list, updatedAt: loaded.updatedAt });
        }
        const tmp = list[idx];
        list[idx] = list[swap];
        list[swap] = tmp;
      } else if (action === "reset_seed" || action === "reset") {
        list = defaultWebsearchRefineSeed();
      } else {
        return jsonResponse({ success: false, error: "未知 action" }, 400);
      }

      list = reindexRefineOrders(list);
      const saved = await saveWebsearchRefineRules(kv, list);
      return jsonResponse({
        success: true,
        rules: saved.rules,
        updatedAt: saved.updatedAt,
      });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  } catch (err) {
    if (err && err.status) return opsAuthErrorResponse(err);
    return jsonResponse(
      { success: false, error: String((err && err.message) || err) },
      500
    );
  }
}
