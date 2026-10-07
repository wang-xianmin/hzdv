/**
 * 开发小组在测试号对话框回复「编号 + 标准答案」→ 写入企业问答并直接发布为标准答
 */
import { readWxuIndex } from "./wx-index.js";
import { readKvUser } from "./kv-secure.js";
import { isDevTeamMember, resolveQaCode, sendCustomText } from "./wx-notify.js";
import { getEnterpriseQa, updateEnterpriseQaReview, publishQaFromReview } from "./agent-qa-d1.js";
import { indexQaGold } from "./catalog-vectorize.js";

const REPLY_RE = /^【?(\d{1,6})】?\s*[:：,，、.。\s]\s*([\s\S]{2,})$/;

export function parseQaReply(text) {
  const m = String(text || "").trim().match(REPLY_RE);
  if (!m) return null;
  return { code: Number(m[1]), answer: m[2].trim().slice(0, 8000) };
}

/**
 * @returns {Promise<{ skipped?: string, published?: string, vector_error?: string }>}
 */
export async function handleDevTeamReply(env, kv, d1, openid, text) {
  if (!kv || !d1 || !openid) return { skipped: "no_binding" };
  const idx = await readWxuIndex(kv, env, openid).catch(() => null);
  if (!idx) return { skipped: "unbound" };
  const row = await readKvUser(kv, env, "phone:" + idx.phone).catch(() => null);
  if (!isDevTeamMember(row) || !row.value || row.value.wxu !== openid) return { skipped: "not_dev" };

  const reply = (msg) =>
    sendCustomText(env, kv, openid, msg).catch((e) =>
      console.warn("[wx-qa-reply] custom send failed:", e && e.message ? e.message : e)
    );

  const parsed = parseQaReply(text);
  if (!parsed) {
    await reply("要发布标准答，请按「编号 空格 标准答案」回复，例如：7 我们的注射装置支持顶部注射");
    return { skipped: "format" };
  }
  const qaId = await resolveQaCode(kv, parsed.code);
  const qa = qaId ? await getEnterpriseQa(d1, qaId) : null;
  if (!qa) {
    await reply("找不到编号 " + parsed.code + " 对应的问题（编号 30 天内有效）");
    return { skipped: "no_qa" };
  }

  const who = String((row.value && row.value.name) || "").slice(0, 20) + "(" + idx.phone.slice(-4) + ")";
  await updateEnterpriseQaReview(d1, qa.id, {
    review_status: "ok",
    corrected_reply: parsed.answer,
    review_note: "微信回答：" + who,
  });
  const gold = await publishQaFromReview(d1, qa.id, {});
  let vector_error = "";
  try {
    await indexQaGold(env, gold);
  } catch (e) {
    vector_error = String((e && e.message) || e);
  }
  const qShort = String(qa.question || "").slice(0, 40);
  await reply(
    vector_error
      ? "已发布【" + parsed.code + "】标准答（" + qShort + "），但向量回灌失败：" + vector_error
      : "已发布【" + parsed.code + "】为标准答：" + qShort
  );
  return { published: gold && gold.id, vector_error };
}
