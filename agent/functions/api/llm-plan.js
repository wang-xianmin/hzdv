/**
 * POST /api/llm-plan
 * 失败恢复：用短请求让梯队模型输出分步 JSON（不执行步骤）。
 *
 * Body: {
 *   phone, message, lang?,
 *   failReason?, hasWebCtx?, intent?,
 *   systemSettings?
 * }
 * Returns: { success, steps: [{op, query?, focus?}], notes, model?, raw? }
 *
 * op 仅允许：websearch | generate（前端按现有短 API 执行）
 */

import {
  assertAnyLoginAccess,
  opsAuthErrorResponse,
  pickKvBinding,
  kvBindingHint,
} from "../lib/host.js";
import { loadLlmModels } from "../lib/llm-models-store.js";
import {
  chatCompletions,
  extractAssistantText,
  llmProxyConfig,
  resolveApiKey,
} from "../lib/openai-compat.js";
import { normalizeUiLang } from "../lib/tier1.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function registryCandidates(env, models, tierOrder) {
  const enabled = (models || []).filter((m) => m && m.enabled !== false);
  const out = [];
  for (const tier of tierOrder) {
    const list = enabled
      .filter((m) => m.tier === tier)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const m of list) {
      if (!m.modelId || !m.baseUrl) continue;
      if (String(m.baseUrl).includes("{WorkspaceId}")) continue;
      if (!resolveApiKey(env, m.apiKeyEnv)) continue;
      out.push(m);
    }
  }
  return out;
}

function extractJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function normalizeSteps(raw, hasWebCtx) {
  const arr = raw && Array.isArray(raw.steps) ? raw.steps : [];
  const out = [];
  let droppedWeb = 0;
  for (const step of arr) {
    if (!step || typeof step !== "object") continue;
    const op = String(step.op || step.type || "")
      .trim()
      .toLowerCase();
    if (op !== "websearch" && op !== "generate") continue;
    if (op === "websearch" && hasWebCtx) {
      droppedWeb += 1;
      continue;
    }
    const item = { op };
    const q = String(step.query || step.q || "").trim();
    const focus = String(step.focus || step.prompt || step.message || "").trim();
    if (op === "websearch") {
      // 无 query 时仍保留步骤，前端会用原用户问题
      if (q) item.query = q.slice(0, 400);
    }
    if (op === "generate" && focus) item.focus = focus.slice(0, 800);
    out.push(item);
    if (out.length >= 4) break;
  }
  // 有材料却只规划了被丢掉的搜网、没有 generate → 补一步生成
  if (hasWebCtx && !out.some((s) => s.op === "generate")) {
    out.push({ op: "generate" });
  }
  return { steps: out, droppedWeb };
}

function pruneStepsForContext(steps, hasWebCtx, uiLang, notes) {
  const norm = normalizeSteps({ steps: steps || [] }, hasWebCtx);
  if (norm.droppedWeb > 0) {
    notes.push(
      uiLang === "en"
        ? "Plan prune: drop " +
          norm.droppedWeb +
          " websearch (web material already present)"
        : "规划取舍：已有联网材料，去掉 " + norm.droppedWeb + " 步 websearch"
    );
  }
  return norm.steps;
}

function fallbackSteps(message, hasWebCtx, uiLang) {
  const q = String(message || "").trim().slice(0, 400);
  if (hasWebCtx) {
    return [
      {
        op: "generate",
        focus:
          uiLang === "en"
            ? "Using ONLY the search material already gathered, answer briefly. If not in the materials, say so; do not invent URLs."
            : "严格只用已有联网材料简要作答；材料里没有就直说，禁止编造链接。",
      },
    ];
  }
  const needWeb = /最新|今天|新闻|实时|股价|天气|核实|查证|latest|today|news|verify/i.test(
    q
  );
  if (needWeb) {
    return [
      { op: "websearch", query: q || (uiLang === "en" ? "latest news" : "最新相关信息") },
      {
        op: "generate",
        focus:
          uiLang === "en"
            ? "Summarize search results and answer briefly. Cite only real URLs from results; never invent links."
            : "根据检索结果简要作答；只引用材料中的真实链接，禁止编造。",
      },
    ];
  }
  return [
    {
      op: "generate",
      focus:
        uiLang === "en"
          ? "Answer the user briefly in one short reply."
          : "用简短回复直接回答用户。",
    },
  ];
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  try {
    await assertAnyLoginAccess(env, body.phone || "");
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  const message = String(body.message || "").trim();
  if (!message) {
    return jsonResponse({ success: false, error: "缺少 message" }, 400);
  }

  const uiLang = normalizeUiLang(body.lang || body.locale || "zh");
  const hasWebCtx = body.hasWebCtx === true || !!body.webCtx;
  const failReason = String(body.failReason || "").slice(0, 400);
  const notes = [];

  const kv = pickKvBinding(env);
  if (!kv) {
    const steps = fallbackSteps(message, hasWebCtx, uiLang);
    notes.push(
      uiLang === "en"
        ? "Plan fallback (no KV): " + steps.length + " step(s)"
        : "规划兜底（无 KV）：" + steps.length + " 步"
    );
    return jsonResponse({ success: true, phase: "plan", steps, notes, fallback: true });
  }

  const { models } = await loadLlmModels(kv, env);
  // 规划用 tier2，失败再用 tier1（短输出）
  const cands = registryCandidates(env, models, [2, 1]);
  if (!cands.length) {
    const steps = fallbackSteps(message, hasWebCtx, uiLang);
    notes.push(
      uiLang === "en"
        ? "Plan fallback (no model): " + steps.length + " step(s)"
        : "规划兜底（无可用模型）：" + steps.length + " 步"
    );
    return jsonResponse({ success: true, phase: "plan", steps, notes, fallback: true });
  }

  const target = cands[0];
  const apiKey = resolveApiKey(env, target.apiKeyEnv);
  const proxy = llmProxyConfig(env);

  const sys =
    uiLang === "en"
      ? "You are a recovery planner. A prior LLM generate timed out. Split the user task into at most 4 short steps. Output JSON only: {\"steps\":[{\"op\":\"websearch\",\"query\":\"...\"},{\"op\":\"generate\",\"focus\":\"...\"}]}. op must be websearch or generate. CRITICAL: if web material is already available (Has web material already: yes), you MUST NOT include any websearch step — only generate. No markdown, no explanation."
      : "你是失败恢复规划器。先前一次 LLM 生成因超时失败。请把用户任务拆成最多 4 个短步骤。只输出 JSON：{\"steps\":[{\"op\":\"websearch\",\"query\":\"...\"},{\"op\":\"generate\",\"focus\":\"...\"}]}。op 只能是 websearch 或 generate。硬性规则：若已有联网材料（「是否已有联网材料：是」），禁止再输出任何 websearch，只能 generate。不要 markdown，不要解释。";

  const user =
    (uiLang === "en"
      ? "Fail reason: " +
        (failReason || "gateway/timeout") +
        "\nHas web material already: " +
        (hasWebCtx ? "yes — DO NOT plan websearch" : "no") +
        "\nUser request:\n"
      : "失败原因：" +
        (failReason || "网关/超时") +
        "\n是否已有联网材料：" +
        (hasWebCtx ? "是（禁止再规划 websearch）" : "否") +
        "\n用户问题：\n") +
    message.slice(0, 1200);

  const result = await chatCompletions({
    baseUrl: proxy ? proxy.baseUrl : target.baseUrl,
    apiKey: proxy ? proxy.apiKey : apiKey,
    upstreamBaseUrl: proxy ? target.baseUrl : null,
    upstreamApiKey: proxy ? apiKey : null,
    model: target.modelId,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    max_tokens: 280,
    timeoutMs: proxy ? 45000 : 20000,
  });

  const raw = extractAssistantText(result.data) || "";
  let parsed = normalizeSteps(extractJsonObject(raw), hasWebCtx);
  let steps = parsed.steps;
  let fallback = false;
  if (parsed.droppedWeb > 0) {
    notes.push(
      uiLang === "en"
        ? "Plan prune: drop " +
          parsed.droppedWeb +
          " websearch (web material already present)"
        : "规划取舍：已有联网材料，去掉 " + parsed.droppedWeb + " 步 websearch"
    );
  }
  if (!steps.length) {
    steps = fallbackSteps(message, hasWebCtx, uiLang);
    fallback = true;
    notes.push(
      uiLang === "en"
        ? "Plan parse failed → heuristic steps"
        : "规划解析失败 → 启发式步骤"
    );
  } else {
    notes.push(
      uiLang === "en"
        ? "Plan → " + steps.length + " step(s) via " + (target.label || target.modelId)
        : "规划 → " + steps.length + " 步 · " + (target.label || target.modelId)
    );
  }
  // 再取舍一遍（兜底步骤也统一走规则）
  steps = pruneStepsForContext(steps, hasWebCtx, uiLang, notes);
  if (proxy) {
    notes.push(
      uiLang === "en" ? "Plan via VPS llm-proxy" : "规划经 VPS llm-proxy"
    );
  }
  if (!result.ok) {
    notes.push(
      uiLang === "en"
        ? "Planner LLM error: " + (result.error || "error")
        : "规划模型错误：" + (result.error || "错误")
    );
  }

  return jsonResponse({
    success: true,
    phase: "plan",
    steps,
    notes,
    fallback,
    raw: raw ? String(raw).slice(0, 600) : "",
    latencyMs: result.latencyMs || 0,
    model: {
      id: target.id || null,
      label: target.label,
      modelId: target.modelId,
      tier: target.tier,
      via: "plan→tier" + target.tier,
    },
  });
}
