/**
 * 目录问句识别
 * - 默认内置同义词（无 D1 时兜底）
 * - 有 D1 同义词表时用 loadCatalogQueryMatchers(d1)
 */

const OUR_SITE =
  /你们|咱们|咱家|贵司|本公司|本站|迪微|HZDV|hzdv|贵公司|你们公司/i;

const BROWSE_ASK =
  /有什么|有哪些|都有什么|介绍一下|看看|列一下|展示一下|有没有|能否介绍|想了解/;

const DEFAULT_MAP = {
  product: ["产品", "单品", "设备", "阀门", "仪表", "模块", "配件", "货品"],
  solution: [
    "方案",
    "系统集成",
    "成套",
    "产线",
    "装配线",
    "集成系统",
    "交钥匙",
  ],
  case: ["案例", "例子", "实例", "应用案例", "成功案例", "项目案例", "样板"],
};

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildCatalogNounRegex(synonymMap) {
  const map = synonymMap || DEFAULT_MAP;
  const terms = [];
  for (const k of ["product", "solution", "case"]) {
    for (const a of map[k] || []) {
      const t = String(a || "").trim();
      if (t && terms.indexOf(t) < 0) terms.push(t);
    }
  }
  terms.push("目录", "型号库", "型号");
  terms.sort((a, b) => b.length - a.length);
  if (!terms.length) return /产品|方案|案例/;
  return new RegExp(terms.map(escapeRegExp).join("|"));
}

export function isBrowseCatalogQuery(message, synonymMap) {
  const s = String(message || "").trim();
  if (!s) return false;
  const noun = buildCatalogNounRegex(synonymMap);
  if (BROWSE_ASK.test(s) && noun.test(s)) return true;
  if (noun.test(s) && /(列表|一览|目录|清单)/.test(s)) return true;
  if (OUR_SITE.test(s) && BROWSE_ASK.test(s)) return true;
  return false;
}

export function isCompanyCatalogQuery(message, synonymMap) {
  const s = String(message || "").trim();
  if (!s) return false;
  if (isBrowseCatalogQuery(s, synonymMap)) return true;
  const noun = buildCatalogNounRegex(synonymMap);
  if (OUR_SITE.test(s) && noun.test(s)) return true;
  if (BROWSE_ASK.test(s) && noun.test(s)) return true;
  if (
    /(有没有|有吗|推荐|适合|用于).{0,20}(装配|产线|阀门|仪表|洁净|模块|工位)/.test(
      s
    )
  ) {
    return true;
  }
  return false;
}

export { DEFAULT_MAP as DEFAULT_CATALOG_SYNONYM_MAP };
