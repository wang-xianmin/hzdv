/**
 * KV 绑定解析：
 * - 兼容历史/不同命名风格（my_kv / MY_KV / myKv / KV 等）
 * - 仅返回具备 get/getWithMetadata 能力的对象
 */

function isKvLike(obj) {
  return !!(
    obj &&
    typeof obj.get === "function" &&
    (typeof obj.getWithMetadata === "function" || typeof obj.put === "function")
  );
}

export function pickKvBinding(env) {
  if (!env || typeof env !== "object") return null;
  const candidates = [
    env.dv_kv,
    env.DV_KV,
    env.my_kv,
    env.MY_KV,
    env.myKv,
    env.MY_kv,
    env.kv,
    env.KV,
    env.USERS_KV,
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (isKvLike(candidates[i])) return candidates[i];
  }
  return null;
}

export function kvBindingHint() {
  return "Pages/Workers 绑定 KV 变量名为 dv_kv（兼容 my_kv / MY_KV）";
}

