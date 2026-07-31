#!/usr/bin/env bash
# 完整意图分类请求（与 agent/functions/lib/intent.js classifyIntent 对齐）
# 用法：在仓库根目录执行
#   bash scripts/test-intent-classify.sh
#   bash scripts/test-intent-classify.sh '中国国内今天最劲爆的新闻是什么？'
# 公网：
#   INTENT_BASE_URL='http://ocr.hzdv.net:8090/v1' bash scripts/test-intent-classify.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${ROOT}/services/intent/.intent_api_key"
BASE_URL="${INTENT_BASE_URL:-http://127.0.0.1:8090/v1}"
MSG="${1:-中国国内今天最劲爆的新闻是什么？}"
TMP_JSON="$(mktemp)"
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_JSON" "$TMP_OUT"' EXIT

if [[ ! -s "$KEY_FILE" ]]; then
  echo "缺少 API Key: $KEY_FILE" >&2
  exit 1
fi

KEY="$(tr -d '\n\r' < "$KEY_FILE")"

MSG="$MSG" python3 -c '
import json, os, sys
prompt = (
    "你是路由分类器。给用户消息分级，只输出一行：tier1、tier2、tier3，需要联网时在后面加空格和 web。\n"
    "tier1：打招呼、闲聊、寒暄。\n"
    "tier2：常规任务：翻译、总结、解释、一般知识、网站功能咨询。\n"
    "tier3：多步推理/长文/编程/方案规划。\n"
    "web：必须查最新新闻、实时数据、股价、天气、赛果、刚发布的产品信息等；纯概念解释不要加 web。\n"
    "示例输出：tier1 / tier2 / tier3 / tier2 web / tier3 web"
)
shots = [
    ("你好", "tier1"),
    ("hello, how are you", "tier1"),
    ("帮我把这段话翻译成英文：今天天气不错", "tier2"),
    ("什么是量子纠缠？", "tier2"),
    ("网站上怎么切换语言", "tier2"),
    ("今天有什么科技新闻", "tier2 web"),
    ("苹果现在股价多少", "tier2 web"),
    ("latest OpenAI model release news", "tier2 web"),
    ("写一个 Python 快速排序并解释时间复杂度", "tier3"),
    ("帮我规划一个三个月的机器学习学习路线", "tier3"),
]
msgs = [{"role": "system", "content": prompt}]
for u, a in shots:
    msgs.append({"role": "user", "content": u})
    msgs.append({"role": "assistant", "content": a})
msgs.append({"role": "user", "content": os.environ["MSG"]})
json.dump({
    "model": "qwen2.5-1.5b-instruct",
    "messages": msgs,
    "temperature": 0,
    "max_tokens": 10,
    "cache_prompt": True,
}, sys.stdout, ensure_ascii=False)
' >"$TMP_JSON"

echo "POST ${BASE_URL}/chat/completions"
echo "message: ${MSG}"
echo "payload_bytes: $(wc -c < "$TMP_JSON")"
echo "---"

set +e
time curl -sS -o "$TMP_OUT" -w "http=%{http_code} curl_time=%{time_total}\n" \
  "${BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d @"$TMP_JSON"
CURL_EC=$?
set -e

echo "curl_exit=${CURL_EC}"
echo "response_bytes: $(wc -c < "$TMP_OUT")"
echo "---"

python3 - "$TMP_OUT" <<'PY'
import json, sys
path = sys.argv[1]
raw = open(path, "rb").read()
if not raw.strip():
    print("空响应（服务未回 body，或连接失败）")
    raise SystemExit(1)
text = raw.decode("utf-8", errors="replace")
try:
    d = json.loads(text)
except Exception as e:
    print("非 JSON / 解析失败：", e)
    print(text[:800])
    raise SystemExit(1)
content = (
    (d.get("choices") or [{}])[0]
    .get("message", {})
    .get("content", "")
)
timings = d.get("timings") or {}
print("content =", repr(content))
print("prompt_ms =", timings.get("prompt_ms"))
print("predicted_ms =", timings.get("predicted_ms"))
if timings.get("prompt_ms") is not None and timings.get("predicted_ms") is not None:
    print("sum_ms ≈", round(float(timings["prompt_ms"]) + float(timings["predicted_ms"]), 1))
print("--- raw json (truncated) ---")
print(json.dumps(d, ensure_ascii=False)[:600])
PY
