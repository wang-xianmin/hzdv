/**
 * Auto 路由模式：
 *   vps = 意图走 VPS 1.5B，生成可经 VPS llm-proxy（方案一）
 *   cf  = 意图走云端 7B（CF 直调），生成 CF 直调云端（方案二，国内友好）
 *
 * 优先级：系统设置 llmRouteMode（0=vps / 1=cf）> env LLM_ROUTE_MODE > 默认 vps
 */

import { llmProxyConfig } from "./openai-compat.js";

export function resolveRouteMode(systemSettings, env) {
  const ss = systemSettings || {};
  const n = Number(ss.llmRouteMode);
  if (n === 1) return "cf";
  if (n === 0) return "vps";
  const e = String((env && env.LLM_ROUTE_MODE) || "")
    .trim()
    .toLowerCase();
  if (e === "cf" || e === "cloudflare" || e === "china") return "cf";
  return "vps";
}

export function isCfRouteMode(systemSettings, env) {
  return resolveRouteMode(systemSettings, env) === "cf";
}

/** 方案二禁止经 VPS llm-proxy；方案一按 Secrets 决定是否走代理 */
export function resolveGenerateProxy(env, systemSettings) {
  if (resolveRouteMode(systemSettings, env) === "cf") return null;
  return llmProxyConfig(env);
}
