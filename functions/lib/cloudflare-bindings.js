/**
 * Cloudflare Pages 绑定名统一解析（与控制台 Variable name 对齐）。
 */

export function pickD1Binding(env) {
  const cands = [
    env.hzdvd1,
    env.DV_D1,
    env.AVATARS_DB,
    env.D1,
    env.DB,
    env.MY_DB,
    env.avatar_db,
  ];
  for (const db of cands) {
    if (db && typeof db.prepare === "function") return db;
  }
  return null;
}

export function pickR2Binding(env) {
  const cands = [env.R2, env.AVATARS_R2, env.MY_R2, env.avatar_r2, env.BUCKET];
  for (const bucket of cands) {
    if (bucket && typeof bucket.get === "function") return bucket;
  }
  return null;
}
