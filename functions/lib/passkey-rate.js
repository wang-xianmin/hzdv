/**
 * Passkey 基础限速（粗粒度，best-effort）。
 * 用 KV 计数 + TTL 窗口。KV 最终一致，仅作粗略限速，不作为安全唯一的保障。
 * 若 KV 未配置则跳过（本地/测试不阻断），生产必须配 KV 或有 WAF 层限速。
 */

import { pickKvBinding } from "./kv-binding.js";

export async function rateLimit(env, bucket, { limit = 15, windowMs = 60000 } = {}) {
  const kv = pickKvBinding(env);
  if (!kv) return true; // KV 未配置：本地/测试放行
  const now = Date.now();
  const key = "pkrl:" + bucket + ":" + Math.floor(now / windowMs);
  let v = 0;
  try {
    const raw = await kv.get(key);
    v = raw ? parseInt(String(raw), 10) || 0 : 0;
  } catch {
    return true;
  }
  if (v >= limit) return false;
  try {
    await kv.put(key, String(v + 1), {
      expirationTtl: Math.ceil(windowMs / 1000) + 5,
    });
  } catch {
    /* best effort */
  }
  return true;
}

export function clientBucketId(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}