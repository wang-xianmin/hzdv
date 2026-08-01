/**
 * POST|GET /api/llm-route
 * 轻量探测：按 Cloudflare cf.country + 系统设置返回选路结果，供 AI 助手启动文案显示。
 *
 * Body（可选）: { systemSettings?, lang? }
 * Returns: { success, mode, country, simulated, launcherHint, ... }
 */

import {
  clientCountryFromRequest,
  formatLauncherRouteHint,
  resolveRouteDecision,
} from "../lib/route-mode.js";
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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
  }

  const uiLang = normalizeUiLang(body.lang || body.locale || "zh");
  const systemSettings = body.systemSettings || body.system_settings || {};
  const country = clientCountryFromRequest(request);
  const decision = resolveRouteDecision(systemSettings, env, { country });
  const launcherHint = formatLauncherRouteHint(decision, uiLang);

  return jsonResponse({
    success: true,
    mode: decision.mode,
    source: decision.source,
    country: decision.country || "",
    realCountry: decision.realCountry || "",
    simulated: !!decision.simulated,
    detail: decision.detail || "",
    launcherHint,
  });
}
