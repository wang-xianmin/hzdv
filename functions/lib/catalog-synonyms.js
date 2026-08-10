/**
 * 目录同义词（D1）：规范词 product|solution|case|service → 用户可维护的说法列表
 *
 * - 问句识别 / 浏览回退：读本表
 * - 重建向量索引：把同义词写入嵌入文本（改完同义词后应重建索引）
 * - 不用 KV：结构化 + 与 catalog 同库，运维权限一致
 */

import { ensureCatalogTables } from "./catalog-d1.js";
import { CATALOG_KIND_KEYS } from "./catalog-query-intent.js";

const CREATE_SYNONYMS_SQL = `
CREATE TABLE IF NOT EXISTS catalog_synonyms (
  canonical TEXT PRIMARY KEY
    CHECK (canonical IN ('product', 'solution', 'case', 'service')),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
)`;

const DEFAULT_ROWS = [
  {
    canonical: "product",
    aliases: ["产品", "单品", "设备", "阀门", "仪表", "模块", "配件", "货品"],
  },
  {
    canonical: "solution",
    aliases: [
      "方案",
      "系统集成",
      "成套",
      "产线",
      "装配线",
      "集成系统",
      "交钥匙",
    ],
  },
  {
    canonical: "case",
    aliases: ["案例", "例子", "实例", "应用案例", "成功案例", "项目案例", "样板"],
  },
  {
    canonical: "service",
    aliases: [
      "服务",
      "售后",
      "质保",
      "保修",
      "维修",
      "培训",
      "安装调试",
      "技术支持",
      "售后服务",
      "客户服务",
    ],
  },
];

const LABEL_ZH = {
  product: "产品",
  solution: "方案",
  case: "案例",
  service: "服务",
};

function nowMs() {
  return Date.now();
}

function parseAliases(raw) {
  try {
    const a = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(a)) return [];
    return a
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i);
  } catch (e) {
    return [];
  }
}

/** 旧表 CHECK 无 service 时重建表结构 */
async function migrateSynonymsAllowService(d1) {
  try {
    await d1
      .prepare(
        `INSERT INTO catalog_synonyms (canonical, aliases_json, updated_at)
         VALUES ('service', '[]', 0)`
      )
      .run();
    await d1
      .prepare(`DELETE FROM catalog_synonyms WHERE canonical = 'service' AND updated_at = 0`)
      .run();
    return;
  } catch (e) {
    // CHECK 拒绝 service → 重建
  }
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS catalog_synonyms_v2 (
        canonical TEXT PRIMARY KEY
          CHECK (canonical IN ('product', 'solution', 'case', 'service')),
        aliases_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )`
    )
    .run();
  await d1
    .prepare(
      `INSERT OR IGNORE INTO catalog_synonyms_v2 (canonical, aliases_json, updated_at)
       SELECT canonical, aliases_json, updated_at FROM catalog_synonyms
       WHERE canonical IN ('product', 'solution', 'case', 'service')`
    )
    .run();
  await d1.prepare(`DROP TABLE catalog_synonyms`).run();
  await d1
    .prepare(`ALTER TABLE catalog_synonyms_v2 RENAME TO catalog_synonyms`)
    .run();
}

export async function ensureCatalogSynonymTable(d1) {
  if (!d1) throw new Error("D1 not configured");
  await ensureCatalogTables(d1);
  await d1.prepare(CREATE_SYNONYMS_SQL).run();
  await migrateSynonymsAllowService(d1);
  for (const row of DEFAULT_ROWS) {
    const existing = await d1
      .prepare(`SELECT canonical FROM catalog_synonyms WHERE canonical = ?`)
      .bind(row.canonical)
      .first();
    if (existing) continue;
    await d1
      .prepare(
        `INSERT INTO catalog_synonyms (canonical, aliases_json, updated_at)
         VALUES (?, ?, ?)`
      )
      .bind(row.canonical, JSON.stringify(row.aliases), nowMs())
      .run();
  }
}

export async function listCatalogSynonyms(d1) {
  await ensureCatalogSynonymTable(d1);
  const rs = await d1
    .prepare(
      `SELECT canonical, aliases_json, updated_at FROM catalog_synonyms
       ORDER BY CASE canonical
         WHEN 'product' THEN 1
         WHEN 'solution' THEN 2
         WHEN 'case' THEN 3
         WHEN 'service' THEN 4
         ELSE 9 END`
    )
    .all();
  const rows = ((rs && rs.results) || []).map((r) => ({
    canonical: String(r.canonical),
    label: LABEL_ZH[r.canonical] || r.canonical,
    aliases: parseAliases(r.aliases_json),
    updated_at: Number(r.updated_at) || 0,
  }));
  // 保证四行都在
  const by = {};
  rows.forEach((r) => {
    by[r.canonical] = r;
  });
  return CATALOG_KIND_KEYS.map((c) => {
    if (by[c]) return by[c];
    const def = DEFAULT_ROWS.find((d) => d.canonical === c);
    return {
      canonical: c,
      label: LABEL_ZH[c],
      aliases: (def && def.aliases) || [],
      updated_at: 0,
    };
  });
}

/** @returns {{ product: string[], solution: string[], case: string[], service: string[] }} */
export async function getCatalogSynonymMap(d1) {
  const rows = await listCatalogSynonyms(d1);
  const map = { product: [], solution: [], case: [], service: [] };
  for (const r of rows) {
    const label = LABEL_ZH[r.canonical] || "";
    const set = new Set([label, ...(r.aliases || [])].filter(Boolean));
    map[r.canonical] = Array.from(set);
  }
  return map;
}

export async function saveCatalogSynonyms(d1, rows) {
  await ensureCatalogSynonymTable(d1);
  const list = Array.isArray(rows) ? rows : [];
  const t = nowMs();
  for (const raw of list) {
    const canonical = String((raw && raw.canonical) || "").trim();
    if (!CATALOG_KIND_KEYS.includes(canonical)) continue;
    const aliases = parseAliases(
      JSON.stringify(
        Array.isArray(raw.aliases)
          ? raw.aliases
          : String(raw.aliases_text || "")
              .split(/[,，、\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
      )
    );
    await d1
      .prepare(
        `INSERT INTO catalog_synonyms (canonical, aliases_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(canonical) DO UPDATE SET
           aliases_json = excluded.aliases_json,
           updated_at = excluded.updated_at`
      )
      .bind(canonical, JSON.stringify(aliases), t)
      .run();
  }
  return listCatalogSynonyms(d1);
}

/** 嵌入用：某 kind 的同义词串 */
export function synonymTextForKind(synonymMap, kind) {
  const k = CATALOG_KIND_KEYS.includes(kind) ? kind : "product";
  const list = (synonymMap && synonymMap[k]) || [];
  return list.join(" ");
}

/** 全部同义词扁平（问句检测用） */
export function flattenSynonymTerms(synonymMap) {
  const out = [];
  if (!synonymMap) return out;
  for (const k of CATALOG_KIND_KEYS) {
    for (const a of synonymMap[k] || []) {
      if (a && out.indexOf(a) < 0) out.push(a);
    }
  }
  return out;
}
