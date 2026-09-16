/**
 * Agent 生成回合状态（KV）——借鉴 Agents fiber：中途进度可查、可续看。
 * 键：hzdv:agent_turn:{turnId}
 * status: running | streaming | background | done | error
 */

import { pickKvBinding } from "./host.js";

export const AGENT_TURN_PREFIX = "hzdv:agent_turn:";
const TURN_TTL_SEC = 900;

/** 流式 delta 写 KV 节流间隔（ms） */
export const TURN_SAVE_THROTTLE_MS = 500;

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

/**
 * 节流写 partialReply；返回 flush() 可在结束时立刻落盘。
 */
export function createThrottledTurnSaver(env, baseTurn, throttleMs) {
  const ms =
    throttleMs == null || throttleMs < 0 ? TURN_SAVE_THROTTLE_MS : throttleMs;
  let lastAt = 0;
  let timer = null;
  let latest = Object.assign({}, baseTurn || {});

  function write() {
    lastAt = Date.now();
    timer = null;
    return saveAgentTurn(env, latest).catch(function () {
      return false;
    });
  }

  return {
    update: function (patch) {
      latest = Object.assign({}, latest, patch || {});
      const now = Date.now();
      if (now - lastAt >= ms) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        write();
        return;
      }
      if (timer) return;
      const wait = Math.max(0, ms - (now - lastAt));
      timer = setTimeout(write, wait);
    },
    flush: function (patch) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (patch) latest = Object.assign({}, latest, patch);
      return write();
    },
    snapshot: function () {
      return latest;
    },
  };
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
