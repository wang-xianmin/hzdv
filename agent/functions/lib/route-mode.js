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
 * 模拟国内（本机测试，不必真实 CN 流量）：
 *   llmRouteDebugCountry：0=关 / 1=模拟CN / 2=模拟US
 *   或 env LLM_ROUTE_DEBUG_COUNTRY=CN|US
 *   仅在自动模式生效；跟踪里会标「模拟」
 *
 * 优先级：系统设置 0/1 强制 > 设置 2/缺省自动（含模拟）> env LLM_ROUTE_MODE
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
 * 调试用国家码：系统设置或 env，用于本机模拟国内/海外选路。
 * @returns {{ country: string, simulated: boolean }}
 */
export function resolveDebugCountry(systemSettings, env) {
  const ss = systemSettings || {};
  const n = Number(ss.llmRouteDebugCountry);
  if (n === 1) return { country: "CN", simulated: true };
  if (n === 2) return { country: "US", simulated: true };
  const e = String((env && env.LLM_ROUTE_DEBUG_COUNTRY) || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
  if (e.length === 2) return { country: e, simulated: true };
  return { country: "", simulated: false };
}

/**
 * @returns {{
 *   mode: "vps"|"cf",
 *   source: "setting"|"auto"|"env",
 *   country: string,
 *   realCountry?: string,
 *   simulated?: boolean,
 *   detail: string,
 * }}
 */
export function resolveRouteDecision(systemSettings, env, opts) {
  const ss = systemSettings || {};
  const realCountry = String((opts && opts.country) || "")
    .trim()
    .toUpperCase();
  const debug = resolveDebugCountry(ss, env);
  const n = Number(ss.llmRouteMode);

  if (n === 0) {
    return {
      mode: "vps",
      source: "setting",
      country: realCountry,
      realCountry,
      simulated: false,
      detail: "force-vps",
    };
  }
  if (n === 1) {
    return {
      mode: "cf",
      source: "setting",
      country: realCountry,
      realCountry,
      simulated: false,
      detail: "force-cf",
    };
  }

  // 2 = 自动；未配置 / NaN 也按自动
  const wantAuto =
    n === 2 ||
    ss.llmRouteMode == null ||
    ss.llmRouteMode === "" ||
    Number.isNaN(n);

  const countryForAuto = debug.simulated ? debug.country : realCountry;

  if (wantAuto) {
    const mode = CF_AUTO_COUNTRIES.has(countryForAuto) ? "cf" : "vps";
    return {
      mode,
      source: "auto",
      country: countryForAuto,
      realCountry,
      simulated: !!debug.simulated,
      detail: debug.simulated
        ? "sim-" + countryForAuto
        : countryForAuto
          ? "geo-" + countryForAuto
          : "geo-unknown→vps",
    };
  }

  const e = String((env && env.LLM_ROUTE_MODE) || "")
    .trim()
    .toLowerCase();
  if (e === "cf" || e === "cloudflare" || e === "china") {
    return {
      mode: "cf",
      source: "env",
      country: realCountry,
      realCountry,
      simulated: false,
      detail: "env-cf",
    };
  }
  if (e === "auto" || e === "geo") {
    const mode = CF_AUTO_COUNTRIES.has(countryForAuto) ? "cf" : "vps";
    return {
      mode,
      source: "env",
      country: countryForAuto,
      realCountry,
      simulated: !!debug.simulated,
      detail: debug.simulated
        ? "env-sim-" + countryForAuto
        : countryForAuto
          ? "env-auto-" + countryForAuto
          : "env-auto-unknown→vps",
    };
  }
  return {
    mode: "vps",
    source: "env",
    country: realCountry,
    realCountry,
    simulated: false,
    detail: "env-vps",
  };
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
    if (uiLang === "en") {
      how =
        "auto" +
        (d.country ? "·" + d.country : "·unknown") +
        (d.simulated ? "·sim" : "");
    } else {
      how =
        "自动" +
        (d.country ? "·" + d.country : "·未知地区→vps") +
        (d.simulated ? "·模拟" : "");
    }
  } else if (d.source === "setting") {
    how = uiLang === "en" ? "forced" : "强制";
  } else {
    how = uiLang === "en" ? "env" : "环境变量";
  }
  return uiLang === "en"
    ? "Route mode → " + mode + " (" + how + ")"
    : "路由模式 → " + modeZh + "（" + how + "）";
}

/** 启动气泡副标题：如「自动·CN」「强制CF」 */
export function formatLauncherRouteHint(decision, uiLang) {
  const d = decision || {};
  if (d.source === "setting") {
    if (d.mode === "cf") {
      return uiLang === "en" ? "Forced · CF" : "强制·CF";
    }
    return uiLang === "en" ? "Forced · VPS" : "强制·VPS";
  }
  if (d.source === "auto" || d.detail && String(d.detail).indexOf("auto") >= 0) {
    const code = d.country || (uiLang === "en" ? "??" : "未知");
    const sim = d.simulated
      ? uiLang === "en"
        ? "·sim"
        : "·模拟"
      : "";
    return uiLang === "en"
      ? "Auto·" + code + sim
      : "自动·" + code + sim;
  }
  if (d.mode === "cf") {
    return uiLang === "en" ? "CF" : "CF方案";
  }
  return uiLang === "en" ? "VPS" : "VPS方案";
}
