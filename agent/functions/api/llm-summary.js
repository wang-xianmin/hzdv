/**
 * POST /api/llm-summary
 * 前情摘要：把「旧摘要 + 刚挤出近期窗口的对话」合成一份新摘要。只返回，不保存；
 * 摘要存在客人本机，提问时随 /api/llm-chat 的 body.memory 带上。
 *
 * Body: { phone, summary?: string, messages: [{ role, content }] }
 * Returns: { success, summary, latencyMs } | { success: false, error }
 */

import { assertAnyLoginAccess, opsAuthErrorResponse } from "../lib/host.js";
import {
  chatCompletions,
  extractAssistantText,
  resolveApiKey,
} from "../lib/openai-compat.js";

const SUMMARY_BASE_URL = "https://api.deepseek.com/v1";
const SUMMARY_MODEL = "deepseek-v4-flash";
const SUMMARY_KEY_ENV = "DEEPSEEK_API_KEY";
const SUMMARY_MAX_CHARS = 400;
const PREV_MAX_CHARS = 600;
const MSG_MAX = 24;
const MSG_MAX_CHARS = 500;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeSummaryMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw.slice(-MSG_MAX)) {
    if (!row || typeof row !== "object") continue;
    const role =
      row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : "";
    if (!role) continue;
    const content = String(row.content || row.text || "").trim();
    if (!content || /^思考中|^Thinking/i.test(content)) continue;
    out.push({ role, content: content.slice(0, MSG_MAX_CHARS) });
  }
  return out;
}

const SUMMARY_SYSTEM =
  "你是客服对话记录整理员，负责维护一份「前情摘要」，供客服助手在后续对话中回忆更早聊过的内容。" +
  "请把【已有摘要】与【新增对话】合并成一份新的摘要，要求：" +
  "1）不超过 350 字，只输出摘要正文，不要标题、不要客套话；" +
  "2）优先保留：客人的需求与用途、提到的产品/型号/规格参数、数量、价格、交期、客人的顾虑与偏好、助手给出的关键结论或承诺、尚未解决的问题；" +
  "3）用「客人」「助手」第三人称陈述，按时间先后，越早的内容可以越精简；" +
  "4）只依据给出的内容，不得编造或补充；" +
  "5）摘要使用对话中客人主要使用的语言。";

function buildSummaryUser(prev, rows) {
  const lines = rows.map(
    (r) => (r.role === "assistant" ? "助手：" : "客人：") + r.content
  );
  return (
    "【已有摘要】\n" +
    (prev || "（无）") +
    "\n\n【新增对话】\n" +
    lines.join("\n")
  );
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
    body.phone = (await assertAnyLoginAccess(env, body.phone || "", request)).phone;
  } catch (err) {
    return opsAuthErrorResponse(err);
  }

  const rows = normalizeSummaryMessages(body.messages);
  if (!rows.length) {
    return jsonResponse({ success: false, error: "缺少 messages" }, 400);
  }
  const prev = String(body.summary || "").trim().slice(0, PREV_MAX_CHARS);
  const apiKey = resolveApiKey(env, SUMMARY_KEY_ENV);
  if (!apiKey) {
    return jsonResponse(
      { success: false, error: "环境变量未配置：" + SUMMARY_KEY_ENV },
      503
    );
  }

  const result = await chatCompletions({
    baseUrl: SUMMARY_BASE_URL,
    apiKey,
    model: SUMMARY_MODEL,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: buildSummaryUser(prev, rows) },
    ],
    temperature: 0.2,
    max_tokens: 600,
    timeoutMs: 20000,
    extraBody: { thinking: { type: "disabled" } },
  });
  if (!result.ok) {
    return jsonResponse(
      { success: false, error: result.error || "summary failed" },
      502
    );
  }
  const summary = String(extractAssistantText(result.data) || "")
    .trim()
    .slice(0, SUMMARY_MAX_CHARS);
  if (!summary) {
    return jsonResponse({ success: false, error: "上游返回空摘要" }, 502);
  }
  return jsonResponse({ success: true, summary, latencyMs: result.latencyMs });
}
