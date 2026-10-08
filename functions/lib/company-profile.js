/**
 * 企业身份卡：agent 各环节调 LLM 时带上，让「你们 / 迪微 / 杭州迪微 / HZDV」都指本公司
 */

export const COMPANY_NAME = "杭州迪微电液数控技术有限公司";

export const COMPANY_REF_HINT_ZH =
  "本公司即杭州迪微电液数控技术有限公司（简称迪微、杭州迪微、HZDV）；" +
  "用户说的「你们」「贵公司」「贵司」「迪微」「杭州迪微」「HZDV」都指本公司，换个称呼问的是同一件事。";

export const COMPANY_PROMPT_ZH =
  "【企业身份】你是杭州迪微电液数控技术有限公司（简称迪微、杭州迪微、HZDV）的网站客服助手。" +
  "用户说的「你们」「贵公司」「贵司」「迪微」「杭州迪微」「HZDV」都指本公司。" +
  "不了解的公司细节不要编造，可请用户看左侧展示区或联系我们。";

export const COMPANY_PROMPT_EN =
  "[Company] You are the website customer-service assistant of 杭州迪微电液数控技术有限公司 (HZDV, also called DiWei / Hangzhou DiWei). " +
  "When the user says \"you\", \"your company\", \"DiWei\" or \"HZDV\", they all mean this company. " +
  "Do not invent company details you do not know; suggest the showcase on the left or contacting us. ";

const COMPANY_REF_RE =
  /杭州迪微电液数控技术有限公司|杭州迪微电液数控技术|杭州迪微电液数控|杭州迪微电液|迪微电液数控|迪微电液|杭州迪微|迪微公司|迪微|hzdv|贵公司|贵司|你们公司|咱们公司|咱们|咱家|本公司/gi;

/** 比对用：把对本公司的各种称呼统一成「你们」（不改存储与展示） */
export function normalizeCompanyRefs(text) {
  return String(text || "")
    .replace(COMPANY_REF_RE, "你们")
    .replace(/(你们)+/g, "你们");
}
