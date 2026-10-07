/**
 * 企业问答判重（向量找候选 + LLM 裁判）、合并重复、彻底删除
 */
import { embedTexts, pickAiBinding, deleteQaGoldVectors, indexQaGold } from "./catalog-vectorize.js";
import { getEnterpriseQa, getQaGold } from "./agent-qa-d1.js";
import { normalizeQuestion, notifyDevTeamOfNewQuestion, forgetQaCode } from "./wx-notify.js";

const CANDIDATE_SCAN_LIMIT = 500;
const BACKFILL_LIMIT = 50;
const TOPK = 3;
const MIN_SIM = 0.5;
const VARIANTS_MAX = 50;
const JUDGE_MODEL = "deepseek-v4-flash";
const JUDGE_URL = "https://api.deepseek.com/v1/chat/completions";
const JUDGE_TIMEOUT_MS = 20000;

export function encodeEmbedding(vec) {
  const bytes = new Uint8Array(new Float32Array(vec).buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decodeEmbedding(b64) {
  const s = atob(String(b64 || ""));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return Array.from(new Float32Array(bytes.buffer));
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function backfillEmbeddings(d1, ai) {
  const rs = await d1
    .prepare("SELECT id, question FROM agent_enterprise_qa WHERE q_embed IS NULL ORDER BY created_at DESC LIMIT ?")
    .bind(BACKFILL_LIMIT)
    .all();
  const rows = ((rs && rs.results) || []).filter((r) => String(r.question || "").trim());
  if (!rows.length) return 0;
  const vecs = await embedTexts(ai, rows.map((r) => r.question));
  for (let i = 0; i < rows.length; i++) {
    await d1
      .prepare("UPDATE agent_enterprise_qa SET q_embed = ? WHERE id = ?")
      .bind(encodeEmbedding(vecs[i]), rows[i].id)
      .run();
  }
  return rows.length;
}

export function buildJudgePrompt(question, cands) {
  const lines = cands.map((c, i) => i + 1 + ". " + c.question).join("\n");
  return (
    "你在给企业网站的客户问题去重。判断【新问题】是否和下面某条【已有问题】在问同一件事" +
    "（换个说法、同义词、口语化都算同一件事；但问得更具体、范围不同、多问了别的方面，都不算）。\n" +
    "本企业是自动化设备与系统集成商：『案例』『成功项目』『做过的系统集成』『项目经验』是同一类；" +
    "『产品』『设备』是同一类；『方案』『解决方案』是同一类。" +
    "对同一类笼统地问『有哪些』『有没有』『介绍一下』，都算同一件事（只要没限定行业、型号、价格等具体条件）。\n" +
    "【新问题】" + question + "\n【已有问题】\n" + lines + "\n" +
    "只输出一个数字：相同的那条的序号；都不相同输出 0。"
  );
}

async function judgeSame(env, question, cands) {
  const key = env && env.DEEPSEEK_API_KEY;
  if (!key) return { pick: -1, error: "no_key" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JUDGE_TIMEOUT_MS);
  try {
    const res = await fetch(JUDGE_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [{ role: "user", content: buildJudgePrompt(question, cands) }],
        temperature: 0,
        max_tokens: 2000,
        thinking: { type: "enabled" },
      }),
    });
    const j = await res.json().catch(() => ({}));
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    const txt = String((msg && msg.content) || "").trim();
    const m = txt.match(/\d+/);
    if (!m) return { pick: -1, error: "bad_output:" + txt.slice(0, 40) };
    return { pick: Number(m[0]) };
  } catch (e) {
    return { pick: -1, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ dupOf: string, method: string, candidates?: {id:string,question:string,sim:number}[], error?: string }>}
 */
export async function findDuplicateQa(env, d1, qa) {
  const id = String(qa.id);
  const ai = pickAiBinding(env);
  if (ai) {
    await backfillEmbeddings(d1, ai).catch((e) =>
      console.warn("[qa-dedupe] backfill failed:", e && e.message ? e.message : e)
    );
  }
  const rs = await d1
    .prepare("SELECT id, question, q_embed FROM agent_enterprise_qa ORDER BY created_at DESC LIMIT ?")
    .bind(CANDIDATE_SCAN_LIMIT)
    .all();
  const rows = (rs && rs.results) || [];
  const self = rows.find((r) => r.id === id);
  const others = rows.filter((r) => r.id !== id);

  const norm = normalizeQuestion(qa.question);
  const exact = norm ? others.find((r) => normalizeQuestion(r.question) === norm) : null;
  if (exact) return { dupOf: exact.id, method: "exact" };

  if (!self || !self.q_embed) return { dupOf: "", method: ai ? "no_embed" : "no_ai" };
  const v = decodeEmbedding(self.q_embed);
  const cands = others
    .filter((r) => r.q_embed)
    .map((r) => ({ id: r.id, question: r.question, sim: cosine(v, decodeEmbedding(r.q_embed)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOPK);
  if (!cands.length || cands[0].sim < MIN_SIM) return { dupOf: "", method: "far", candidates: cands };

  const j = await judgeSame(env, qa.question, cands);
  if (j.pick >= 1 && j.pick <= cands.length) {
    return { dupOf: cands[j.pick - 1].id, method: "llm", candidates: cands };
  }
  return { dupOf: "", method: j.pick === 0 ? "llm_new" : "llm_error", candidates: cands, error: j.error };
}

export async function mergeQaInto(env, d1, keepId, dup) {
  const keep = await getEnterpriseQa(d1, keepId);
  if (!keep) return { merged: false };
  const q = String((dup && dup.question) || "").trim();
  const variants = keep.q_variants.slice();
  if (q && q !== keep.question && variants.indexOf(q) < 0) variants.push(q);
  await d1
    .prepare(
      "UPDATE agent_enterprise_qa SET ask_count = COALESCE(ask_count, 1) + 1, q_variants = ?, last_asked_at = ? WHERE id = ?"
    )
    .bind(JSON.stringify(variants.slice(-VARIANTS_MAX)), Number(dup && dup.created_at) || Date.now(), keep.id)
    .run();
  await d1.prepare("DELETE FROM agent_enterprise_qa WHERE id = ?").bind(String(dup.id)).run();

  let gold_error = "";
  if (keep.published_gold_id && q) {
    const gold = await getQaGold(d1, keep.published_gold_id);
    if (gold && gold.is_active && q !== gold.question_canonical && gold.question_variants.indexOf(q) < 0) {
      const gv = gold.question_variants.concat([q]).slice(-VARIANTS_MAX);
      await d1
        .prepare("UPDATE agent_qa_gold SET question_variants = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(gv), Date.now(), gold.id)
        .run();
      try {
        await indexQaGold(env, { ...gold, question_variants: gv });
      } catch (e) {
        gold_error = String((e && e.message) || e);
      }
    }
  }
  return { merged: true, keep: keep.id, ask_count: keep.ask_count + 1, gold_error };
}

export async function processNewQa(env, kv, d1, qa) {
  if (!qa || !d1) return { skipped: "no_binding" };
  let dup;
  try {
    dup = await findDuplicateQa(env, d1, qa);
  } catch (e) {
    dup = { dupOf: "", method: "error", error: String((e && e.message) || e) };
  }
  const sims = (dup.candidates || []).map((c) => Math.round(c.sim * 1000) / 1000);
  if (dup.dupOf) {
    const merged = await mergeQaInto(env, d1, dup.dupOf, qa);
    return { dedupe: dup.method, sims, ...merged };
  }
  const notify = await notifyDevTeamOfNewQuestion(env, kv, d1, qa);
  return { dedupe: dup.method, sims, error: dup.error, notify };
}

export async function deleteEnterpriseQaFully(env, d1, kv, id) {
  const qa = await getEnterpriseQa(d1, id);
  if (!qa) return { deleted: 0, gold_deleted: 0, vector_errors: [] };
  const rs = await d1
    .prepare("SELECT id FROM agent_qa_gold WHERE source_qa_id = ? OR id = ?")
    .bind(qa.id, qa.published_gold_id || "")
    .all();
  let gold_deleted = 0;
  const vector_errors = [];
  for (const r of (rs && rs.results) || []) {
    const gold = await getQaGold(d1, r.id);
    if (gold) {
      try {
        await deleteQaGoldVectors(env, gold);
      } catch (e) {
        vector_errors.push(String((e && e.message) || e));
      }
    }
    await d1.prepare("DELETE FROM agent_qa_gold WHERE id = ?").bind(r.id).run();
    gold_deleted++;
  }
  if (kv && qa.wx_code) await forgetQaCode(kv, qa.wx_code).catch(() => {});
  const del = await d1.prepare("DELETE FROM agent_enterprise_qa WHERE id = ?").bind(qa.id).run();
  return { deleted: Number((del && del.meta && del.meta.changes) || 0), gold_deleted, vector_errors };
}
