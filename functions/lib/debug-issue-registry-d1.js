/**
 * 与 avatar / posts 共用 D1 绑定选择逻辑（任选一个含 prepare 的 DB）。
 */

import { pickD1Binding } from "./cloudflare-bindings.js";

export function pickD1ForDebugRegistry(env) {
  return pickD1Binding(env);
}
