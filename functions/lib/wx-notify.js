/**
 * 企业问答新问题 → 测试号模板消息，逐个推给开发小组
 * 开发小组 = metadata.cnt_dev 第 5 位为 1（算法同登录后 USER_TYPE_CNT_DEV）且未注销（status!==3）且已绑微信（value.wxu）
 */
import { getMpAccessToken, ACCESS_TOKEN_KEY } from "./wx-mp.js";
import { listKvUserStorageKeys, readKvUserByStorageKey } from "./kv-secure.js";
import { roleOf } from "./auth-roles.js";

export const WX_NOTIFY_TEMPLATE_ID_DEFAULT = "uJJfsDsMiUSzPv8tn8pxOozm29AR3Y9gBlzWd2JJ9So";
const NOTIFY_LINK = "https://hzdv.net/";
const QUESTION_MAX = 60;
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

/**
 * cnt_dev 第 5 位（位值 16）判定，算法与登录后 USER_TYPE_CNT_DEV 相同：
 * 纯 0/1 串按二进制解析，否则按十进制；空或 NaN 为 0；(n & 16) !== 0 则为 1。
 */
function cntDevBitOn(raw) {
  if (raw == null || String(raw).trim() === "") return 0;
  const s = String(raw).trim();
  const n = /^[01]+$/.test(s) ? parseInt(s, 2) : parseInt(s, 10);
  if (!isFinite(n)) return 0;
  return (n & 16) !== 0 ? 1 : 0;
}

export function isDevTeamMember(row) {
  if (!row) return false;
  const role = roleOf(row);
  if (role.status === 3) return false;
  return cntDevBitOn((row.metadata || {}).cnt_dev) === 1;
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

export async function listDevTeamOpenids(kv, env, stats) {
  const out = new Set();
  const st = stats || {};
  Object.assign(st, { keys: 0, read: 0, readErr: 0, cntDev: 0, withWxu: 0, firstErr: "" });
  const keys = await listKvUserStorageKeys(kv);
  st.keys = keys.length;
  for (const sk of keys) {
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row) continue;
      st.read++;
      const isDev = isDevTeamMember(row);
      if (isDev) st.cntDev++;
      const wxu = row.value && typeof row.value.wxu === "string" ? row.value.wxu.trim() : "";
      if (wxu) st.withWxu++;
      if (wxu && isDev) out.add(wxu);
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

export async function forgetQaCode(kv, code) {
  if (!code) return;
  await kv.delete(QA_CODE_PREFIX + Number(code));
}

/**
 * @returns {Promise<{ skipped?: string, recipients?: number, sent?: number, failed?: any[] }>}
 */
export async function notifyDevTeamOfNewQuestion(env, kv, d1, qa) {
  if (!qa || !kv || !d1) return { skipped: "no_binding" };
  if (qa.answer_mode === "gold") return { skipped: "gold" };
  if (!env.WX_MP_APPID || !env.WX_MP_APPSECRET) return { skipped: "no_mp" };

  const stats = {};
  const openids = await listDevTeamOpenids(kv, env, stats);
  if (!openids.length) return { skipped: "no_recipient", stats };

  const code = await allocQaCode(kv, qa.id);
  await d1
    .prepare("UPDATE agent_enterprise_qa SET wx_code = ? WHERE id = ?")
    .bind(code, String(qa.id))
    .run()
    .catch(() => {});
  const q = String(qa.question || "").replace(/\s+/g, " ").trim();
  const a = String(qa.reply_text || "").replace(/\s+/g, " ").trim();
  const data = {
    question: { value: "【" + code + "】" + (q.length > QUESTION_MAX ? q.slice(0, QUESTION_MAX) + "…" : q) },
    answer: { value: a ? (a.length > ANSWER_MAX ? a.slice(0, ANSWER_MAX) + "…" : a) : "（无）" },
    hint: { value: "要发布标准答，直接回复：" + code + " 加空格再写答案" },
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
