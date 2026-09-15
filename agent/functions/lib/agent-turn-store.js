/**
 * Agent 生成回合状态（KV）——借鉴 Agents fiber：中途进度可查、可续看。
 * 键：hzdv:agent_turn:{turnId}
 */

import { pickKvBinding } from "./host.js";

export const AGENT_TURN_PREFIX = "hzdv:agent_turn:";
const TURN_TTL_SEC = 600;

export function newTurnId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return "t" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  }
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function saveAgentTurn(env, turn) {
  const kv = pickKvBinding(env);
  if (!kv || !turn || !turn.id) return false;
  const row = {
    ...turn,
    updatedAt: Date.now(),
  };
  await kv.put(AGENT_TURN_PREFIX + turn.id, JSON.stringify(row), {
    expirationTtl: TURN_TTL_SEC,
  });
  return true;
}

export async function loadAgentTurn(env, turnId) {
  const kv = pickKvBinding(env);
  const id = String(turnId || "").trim();
  if (!kv || !id) return null;
  const raw = await kv.get(AGENT_TURN_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export function publicTurnView(turn) {
  if (!turn) return null;
  return {
    id: turn.id,
    status: turn.status || "unknown",
    partialReply: turn.partialReply || "",
    reply: turn.reply || "",
    error: turn.error || null,
    model: turn.model || null,
    notes: Array.isArray(turn.notes) ? turn.notes : [],
    attempts: Array.isArray(turn.attempts) ? turn.attempts : [],
    createdAt: turn.createdAt || null,
    updatedAt: turn.updatedAt || null,
    doneAt: turn.doneAt || null,
  };
}
