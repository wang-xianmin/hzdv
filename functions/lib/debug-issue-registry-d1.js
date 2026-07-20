/**
 * 与 avatar / posts 共用 D1 绑定选择逻辑（任选一个含 prepare 的 DB）。
 */

export function pickD1ForDebugRegistry(env) {
  const cands = [env.AVATARS_DB, env.D1, env.DB, env.MY_DB, env.avatar_db];
  for (const db of cands) {
    if (db && typeof db.prepare === "function") return db;
  }
  return null;
}
