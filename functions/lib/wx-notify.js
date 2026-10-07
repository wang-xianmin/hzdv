/**
 * 企业问答新问题 → 测试号模板消息，逐个推给开发小组
 * 开发小组 = A 类（type 含 0x10）且 uA_Tier=1 且已绑微信（value.wxu）
 */
import { getMpAccessToken, ACCESS_TOKEN_KEY } from "./wx-mp.js";
import { listKvUserStorageKeys, readKvUserByStorageKey } from "./kv-secure.js";
import { roleOf } from "./auth-roles.js";

export const WX_NOTIFY_TEMPLATE_ID_DEFAULT = "zSUI1qodJYh4QJfb8Fs8JQg1vmNQAivpRJ-XZKWbZRk";
export const USER_TYPE_UA = 0x10;
export const UA_TIER_DEV_TEAM = 1;
const NOTIFY_LINK = "https://hzdv.net/";
const QUESTION_MAX = 60;
const REPEAT_SCAN_LIMIT = 2000;
const ANSWER_MAX = 200;
const QA_SEQ_KEY = "wxqa:seq";
const QA_CODE_PREFIX = "wxqa:n:";
const QA_CODE_TTL = 30 * 24 * 3600;

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

export async function listDevTeamOpenids(kv, env, stats) {
  const out = new Set();
  const st = stats || {};
  Object.assign(st, { keys: 0, read: 0, readErr: 0, typeA: 0, tier1: 0, typeAtier1: 0, withWxu: 0, firstErr: "" });
  const keys = await listKvUserStorageKeys(kv);
  st.keys = keys.length;
  for (const sk of keys) {
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row) continue;
      st.read++;
      const isA = (roleOf(row).typeMask & USER_TYPE_UA) !== 0;
      const isTier1 = Number((row.metadata || {}).uA_Tier) === UA_TIER_DEV_TEAM;
      if (isA) st.typeA++;
      if (isTier1) st.tier1++;
      if (isA && isTier1) st.typeAtier1++;
      const wxu = row.value && typeof row.value.wxu === "string" ? row.value.wxu.trim() : "";
      if (wxu) st.withWxu++;
      if (wxu && isDevTeamMember(row)) out.add(wxu);
    } catch (e) {
      st.readErr++;
      if (!st.firstErr) st.firstErr = String((e && e.message) || e).slice(0, 120);
    }
  }
  return Array.from(out);
}

async function postMp(env, kv, path, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getMpAccessToken(env, kv);
    const res = await fetch(
      "https://api.weixin.qq.com/cgi-bin/" + path + "?access_token=" + encodeURIComponent(token),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

function sendTemplate(env, kv, openid, data) {
  return postMp(env, kv, "message/template/send", {
    touser: openid,
    template_id: env.WX_NOTIFY_TEMPLATE_ID || WX_NOTIFY_TEMPLATE_ID_DEFAULT,
    url: NOTIFY_LINK,
    data,
  });
}

export function sendCustomText(env, kv, openid, content) {
  return postMp(env, kv, "message/custom/send", {
    touser: openid,
    msgtype: "text",
    text: { content: String(content || "") },
  });
}

export async function allocQaCode(kv, qaId) {
  const n = (Number(await kv.get(QA_SEQ_KEY)) || 0) + 1;
  await kv.put(QA_SEQ_KEY, String(n));
  await kv.put(QA_CODE_PREFIX + n, String(qaId), { expirationTtl: QA_CODE_TTL });
  return n;
}

export async function resolveQaCode(kv, code) {
  const id = await kv.get(QA_CODE_PREFIX + Number(code));
  return id ? String(id) : "";
}

/**
 * @returns {Promise<{ skipped?: string, recipients?: number, sent?: number, failed?: any[] }>}
 */
export async function notifyDevTeamOfNewQuestion(env, kv, d1, qa) {
  if (!qa || !kv || !d1) return { skipped: "no_binding" };
  if (qa.answer_mode === "gold") return { skipped: "gold" };
  if (!env.WX_MP_APPID || !env.WX_MP_APPSECRET) return { skipped: "no_mp" };

  if (await isRepeatQuestion(d1, qa)) return { skipped: "repeat" };

  const stats = {};
  const openids = await listDevTeamOpenids(kv, env, stats);
  if (!openids.length) return { skipped: "no_recipient", stats };

  const code = await allocQaCode(kv, qa.id);
  const q = String(qa.question || "").replace(/\s+/g, " ").trim();
  const a = String(qa.reply_text || "").replace(/\s+/g, " ").trim();
  const data = {
    question: { value: "【" + code + "】" + (q.length > QUESTION_MAX ? q.slice(0, QUESTION_MAX) + "…" : q) },
    answer: { value: a ? (a.length > ANSWER_MAX ? a.slice(0, ANSWER_MAX) + "…" : a) : "（无）" },
    hint: { value: "回复「" + code + " 标准答案」即可发布为标准答" },
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
  console.log("[wx-notify]", qa.id, JSON.stringify({ recipients: openids.length, sent, failed, code }));
  return { recipients: openids.length, sent, failed, code };
}
