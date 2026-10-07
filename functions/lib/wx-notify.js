/**
 * 企业问答新问题 → 测试号模板消息，逐个推给开发小组
 * 开发小组 = A 类（type 含 0x10）且 uA_Tier=1 且已绑微信（value.wxu）
 */
import { getMpAccessToken, ACCESS_TOKEN_KEY } from "./wx-mp.js";
import { listKvUserStorageKeys, readKvUserByStorageKey, readKvUser } from "./kv-secure.js";
import { roleOf } from "./auth-roles.js";

export const WX_NOTIFY_TEMPLATE_ID_DEFAULT = "zSUI1qodJYh4QJfb8Fs8JQg1vmNQAivpRJ-XZKWbZRk";
export const USER_TYPE_UA = 0x10;
export const UA_TIER_DEV_TEAM = 1;
const OPS_TYPE_MASK = 0x0f;
const NOTIFY_LINK = "https://hzdv.net/";
const QUESTION_MAX = 60;
const REPEAT_SCAN_LIMIT = 2000;

const CATEGORY_LABEL = { product: "产品", solution: "方案", case: "案例", service: "服务", other: "其他" };
const MODE_LABEL = {
  gold: "已有标准答",
  showcase_pointer: "已指向目录",
  catalog_miss: "目录里没找到",
  prose: "AI 自由回答",
};

export function isDevTeamMember(row) {
  if (!row) return false;
  const role = roleOf(row);
  if (role.status === 3) return false;
  const tier = Number((row.metadata || {}).uA_Tier);
  return (role.typeMask & USER_TYPE_UA) !== 0 && tier === UA_TIER_DEV_TEAM;
}

function isInternalAsker(row) {
  if (!row) return false;
  return (roleOf(row).typeMask & OPS_TYPE_MASK) !== 0 || isDevTeamMember(row);
}

export function normalizeQuestion(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/[吗呢啊吧呀哦嘛]+$/u, "");
}

export function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length >= 7) return d.slice(0, 3) + "****" + d.slice(-4);
  return d || "未知";
}

function fmtBeijing(ms) {
  const t = Number(ms) || Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function isRepeatQuestion(d1, qa) {
  const norm = normalizeQuestion(qa.question);
  if (!norm) return true;
  const rs = await d1
    .prepare(
      "SELECT question FROM agent_enterprise_qa WHERE id != ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(String(qa.id), Number(qa.created_at) || Date.now(), REPEAT_SCAN_LIMIT)
    .all();
  const rows = (rs && rs.results) || [];
  return rows.some((r) => normalizeQuestion(r.question) === norm);
}

export async function listDevTeamOpenids(kv, env) {
  const out = new Set();
  const keys = await listKvUserStorageKeys(kv);
  for (const sk of keys) {
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      const wxu = row && row.value && typeof row.value.wxu === "string" ? row.value.wxu.trim() : "";
      if (wxu && isDevTeamMember(row)) out.add(wxu);
    } catch {
      /* skip */
    }
  }
  return Array.from(out);
}

async function sendTemplate(env, kv, openid, data) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getMpAccessToken(env, kv);
    const res = await fetch(
      "https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" + encodeURIComponent(token),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: openid,
          template_id: env.WX_NOTIFY_TEMPLATE_ID || WX_NOTIFY_TEMPLATE_ID_DEFAULT,
          url: NOTIFY_LINK,
          data,
        }),
      }
    );
    const j = await res.json().catch(() => ({}));
    if ((j.errcode === 40001 || j.errcode === 42001) && attempt === 0) {
      await kv.delete(ACCESS_TOKEN_KEY).catch(() => {});
      continue;
    }
    return j;
  }
  return {};
}

/**
 * @returns {Promise<{ skipped?: string, recipients?: number, sent?: number, failed?: any[] }>}
 */
export async function notifyDevTeamOfNewQuestion(env, kv, d1, qa) {
  if (!qa || !kv || !d1) return { skipped: "no_binding" };
  if (qa.answer_mode === "gold") return { skipped: "gold" };
  if (!env.WX_MP_APPID || !env.WX_MP_APPSECRET) return { skipped: "no_mp" };

  const phone = String(qa.user_phone || "").replace(/\D/g, "");
  if (phone.length >= 6) {
    const asker = await readKvUser(kv, env, "phone:" + phone).catch(() => null);
    if (isInternalAsker(asker)) return { skipped: "internal" };
  }
  if (await isRepeatQuestion(d1, qa)) return { skipped: "repeat" };

  const openids = await listDevTeamOpenids(kv, env);
  if (!openids.length) return { skipped: "no_recipient" };

  const q = String(qa.question || "").replace(/\s+/g, " ").trim();
  const data = {
    question: { value: q.length > QUESTION_MAX ? q.slice(0, QUESTION_MAX) + "…" : q },
    category: { value: CATEGORY_LABEL[qa.category] || qa.category || "其他" },
    mode: { value: MODE_LABEL[qa.answer_mode] || qa.answer_mode || "未知" },
    asker: { value: maskPhone(qa.user_phone) },
    time: { value: fmtBeijing(qa.created_at) },
  };

  let sent = 0;
  const failed = [];
  for (const openid of openids) {
    try {
      const j = await sendTemplate(env, kv, openid, data);
      if (j && j.errcode === 0) sent++;
      else failed.push(j && j.errcode != null ? j.errcode : "no_response");
    } catch (e) {
      failed.push(String((e && e.message) || e));
    }
  }
  console.log("[wx-notify]", qa.id, JSON.stringify({ recipients: openids.length, sent, failed }));
  return { recipients: openids.length, sent, failed };
}
