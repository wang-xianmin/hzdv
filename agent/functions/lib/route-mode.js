/**
 * Auto 路由模式：
 *   vps = 意图走 VPS 1.5B，生成可经 VPS llm-proxy（方案一）
 *   cf  = 意图走云端 7B（CF 直调），生成 CF 直调云端（方案二，国内友好）
 *
 * 系统设置 llmRouteMode：
 *   0 = 强制 VPS
 *   1 = 强制 CF
 *   2 = 自动（按访客 Cloudflare 国家码；默认）
 *     中国大陆 CN → cf，其它 → vps
 *
 * 优先级：系统设置 0/1 强制 > 设置 2/缺省自动 > env LLM_ROUTE_MODE
 */

import { llmProxyConfig } from "./openai-compat.js";

/** 自动选 CF 的国家码（ISO 3166-1 alpha-2） */
const CF_AUTO_COUNTRIES = new Set(["CN"]);

export function clientCountryFromRequest(request) {
  try {
    const cf = request && request.cf;
    return String((cf && cf.country) || "")
      .trim()
      .toUpperCase();
  } catch (e) {
    return "";
  }
}

/**
 * @returns {{
 *   mode: "vps"|"cf",
 *   source: "setting"|"auto"|"env",
 *   country: string,
 *   detail: string,
 * }}
 */
export function resolveRouteDecision(systemSettings, env, opts) {
  const ss = systemSettings || {};
  const country = String((opts && opts.country) || "")
    .trim()
    .toUpperCase();
  const n = Number(ss.llmRouteMode);

  if (n === 0) {
    return {
      mode: "vps",
      source: "setting",
      country,
      detail: "force-vps",
    };
  }
  if (n === 1) {
    return {
      mode: "cf",
      source: "setting",
      country,
      detail: "force-cf",
    };
  }

  // 2 = 自动；未配置 / NaN 也按自动（默认国内友好）
  const wantAuto =
    n === 2 ||
    ss.llmRouteMode == null ||
    ss.llmRouteMode === "" ||
    Number.isNaN(n);

  if (wantAuto) {
    const mode = CF_AUTO_COUNTRIES.has(country) ? "cf" : "vps";
    return {
      mode,
      source: "auto",
      country,
      detail: country
        ? "geo-" + country
        : "geo-unknown→vps",
    };
  }

  const e = String((env && env.LLM_ROUTE_MODE) || "")
    .trim()
    .toLowerCase();
  if (e === "cf" || e === "cloudflare" || e === "china") {
    return { mode: "cf", source: "env", country, detail: "env-cf" };
  }
  if (e === "auto" || e === "geo") {
    const mode = CF_AUTO_COUNTRIES.has(country) ? "cf" : "vps";
    return {
      mode,
      source: "env",
      country,
      detail: country ? "env-auto-" + country : "env-auto-unknown→vps",
    };
  }
  return { mode: "vps", source: "env", country, detail: "env-vps" };
}

export function resolveRouteMode(systemSettings, env, opts) {
  return resolveRouteDecision(systemSettings, env, opts).mode;
}

export function isCfRouteMode(systemSettings, env, opts) {
  return resolveRouteMode(systemSettings, env, opts) === "cf";
}

/** 方案二禁止经 VPS llm-proxy；方案一按 Secrets 决定是否走代理 */
export function resolveGenerateProxy(env, systemSettings, opts) {
  if (resolveRouteMode(systemSettings, env, opts) === "cf") return null;
  return llmProxyConfig(env);
}

export function formatRouteModeNote(decision, uiLang) {
  const d = decision || {};
  const mode = d.mode === "cf" ? "cf" : "vps";
  const modeZh = mode === "cf" ? "cf（国内/直调）" : "vps";
  let how;
  if (d.source === "auto") {
    how =
      uiLang === "en"
        ? "auto" + (d.country ? "·" + d.country : "·unknown")
        : "自动" + (d.country ? "·" + d.country : "·未知地区→vps");
  } else if (d.source === "setting") {
    how = uiLang === "en" ? "forced" : "强制";
  } else {
    how = uiLang === "en" ? "env" : "环境变量";
  }
  return uiLang === "en"
    ? "Route mode → " + mode + " (" + how + ")"
    : "路由模式 → " + modeZh + "（" + how + "）";
}
