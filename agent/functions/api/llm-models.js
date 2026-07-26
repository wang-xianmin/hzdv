/**
 * LLM 模型库（第一/二/三梯队，全部可编辑）
 * GET  /api/llm-models              公开列表（供 agent 选择）
 * GET  /api/llm-models?admin=1&phone=  运维完整列表
 * PUT  /api/llm-models  JSON { phone, models: [...] }  全量保存
 * POST /api/llm-models  JSON { phone, action, ... }   增删改排序
 */

import {
  pickKvBinding,
  kvBindingHint,
  assertOpsAccess,
  opsAuthErrorResponse,
} from "../lib/host.js";
import {
  loadLlmModels,
  normalizeModel,
  reindexTierOrders,
  saveLlmModels,
  sortModels,
  toPickerItems,
} from "../lib/llm-models-store.js";

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
  return (
    (body && body.phone) ||
    u.searchParams.get("phone") ||
    ""
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = pickKvBinding(env);
  if (!kv) {
    return jsonResponse({ success: false, error: "KV not configured", hint: kvBindingHint() }, 503);
  }

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const admin = url.searchParams.get("admin") === "1";
      const { models, seeded, migrated, updatedAt } = await loadLlmModels(kv, env);
      if (admin) {
        await assertOpsAccess(env, phoneOf(request, null));
        return jsonResponse({
          success: true,
          models,
          seeded: !!seeded,
          migrated: !!migrated,
          updatedAt,
        });
      }
      return jsonResponse({
        success: true,
        models: toPickerItems(models),
        seeded: !!seeded,
        updatedAt,
      });
    }

    if (request.method === "PUT") {
      const body = await readJson(request);
      if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      await assertOpsAccess(env, phoneOf(request, body));
      const saved = await saveLlmModels(kv, body.models || []);
      return jsonResponse({ success: true, models: saved.models, updatedAt: saved.updatedAt });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body) return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      await assertOpsAccess(env, phoneOf(request, body));
      const action = String(body.action || "").trim();
      const loaded = await loadLlmModels(kv, env);
      let list = loaded.models.slice();

      if (action === "add" || action === "create") {
        const m = normalizeModel(body.model || body);
        if (!m.modelId || !m.baseUrl) {
          return jsonResponse({ success: false, error: "modelId 与 baseUrl 必填" }, 400);
        }
        const sameTier = list.filter((x) => x.tier === m.tier);
        m.order =
          sameTier.length === 0
            ? 0
            : Math.max(...sameTier.map((x) => x.order)) + 1;
        list.push(m);
      } else if (action === "update") {
        const id = String(body.id || (body.model && body.model.id) || "").trim();
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) return jsonResponse({ success: false, error: "模型不存在" }, 404);
        const patch = body.model || body;
        list[idx] = normalizeModel({ ...list[idx], ...patch, id });
      } else if (action === "delete" || action === "remove") {
        const id = String(body.id || "").trim();
        list = list.filter((x) => x.id !== id);
      } else if (action === "move") {
        const id = String(body.id || "").trim();
        const direction = String(body.direction || "").trim(); // up | down
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) return jsonResponse({ success: false, error: "模型不存在" }, 404);
        const tier = list[idx].tier;
        const peers = sortModels(list.filter((x) => x.tier === tier));
        const pidx = peers.findIndex((x) => x.id === id);
        const swapWith = direction === "up" ? pidx - 1 : pidx + 1;
        if (swapWith < 0 || swapWith >= peers.length) {
          return jsonResponse({ success: true, models: sortModels(list) });
        }
        const a = peers[pidx].order;
        peers[pidx].order = peers[swapWith].order;
        peers[swapWith].order = a;
        const map = {};
        peers.forEach((p) => {
          map[p.id] = p.order;
        });
        list = list.map((m) => (map[m.id] == null ? m : { ...m, order: map[m.id] }));
      } else if (action === "reset_seed") {
        list = (await import("../lib/llm-models-store.js")).defaultLlmModelsSeed(env);
      } else {
        return jsonResponse({ success: false, error: "Unknown action" }, 400);
      }

      const saved = await saveLlmModels(kv, reindexTierOrders(list));
      return jsonResponse({ success: true, models: saved.models, updatedAt: saved.updatedAt });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  } catch (err) {
    if (err && err.status) return opsAuthErrorResponse(err);
    console.error("llm-models:", err);
    return jsonResponse({ success: false, error: String((err && err.message) || err) }, 500);
  }
}
