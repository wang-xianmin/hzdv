/**
 * Passkey 安全配置解析。
 * 所有来源都是环境变量；任何缺失都回退到安全默认，不做危险猜测。
 *
 * PASSKEY_ENABLED       灰度开关，默认 false（本轮默认关闭）。
 * PASSKEY_RP_ID          固定 hzdv.net（注册域名，不是 www）。
 * PASSKEY_RP_NAME        展示名，默认 HZDV。
 * PASSKEY_ALLOWED_ORIGINS 显式白名单，逗号分隔，禁止通配符。
 * PASSKEY_REAUTH_TTL_MS   reauth 票据 TTL，默认 300000 (5 分钟)。
 * PASSKEY_CHALLENGE_TTL_MS challenge TTL，默认 300000 (5 分钟)。
 */

function parseBool(v, def) {
  const s = String(v == null ? "" : v).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "1") return true;
  if (s === "0") return false;
  return def;
}

function parsePositiveInt(v, fallback) {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function passkeyEnabled(env) {
  return parseBool(env && env.PASSKEY_ENABLED, false);
}

export function rpId(env) {
  const v = String((env && env.PASSKEY_RP_ID) || "hzdv.net").trim();
  return v || "hzdv.net";
}

export function rpName(env) {
  const v = String((env && env.PASSKEY_RP_NAME) || "HZDV").trim();
  return v || "HZDV";
}

export function allowedOrigins(env) {
  const raw = String(
    (env && env.PASSKEY_ALLOWED_ORIGINS) || "https://hzdv.net,https://www.hzdv.net"
  );
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(env, origin) {
  return allowedOrigins(env).indexOf(String(origin || "")) !== -1;
}

export function reauthTtlMs(env) {
  return parsePositiveInt(env && env.PASSKEY_REAUTH_TTL_MS, 300000);
}

export function challengeTtlMs(env) {
  return parsePositiveInt(env && env.PASSKEY_CHALLENGE_TTL_MS, 300000);
}