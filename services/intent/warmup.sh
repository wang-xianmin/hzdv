#!/bin/sh
# 改了意图分类提示词（agent/functions/lib/intent.js 或 functions/lib/company-profile.js）并推送后跑一次：
# 用与线上完全相同的提示词预热 VPS 分类器的提示词缓存。
# 缓存失效时整段提示词要从头算（2 核 CPU 约 20 秒），线上只等 6 秒，第一个客人问题会超时。
# 用法（仓库根目录）：sh services/intent/warmup.sh
set -e
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/agent"
cp -R functions "$T/"
cp -R agent/functions "$T/agent/"
echo '{"type":"module"}' > "$T/package.json"
(cd "$T" && node --input-type=module -e '
import { classifyIntent } from "./agent/functions/lib/intent.js";
globalThis.fetch = async (url, init) => {
  process.stdout.write(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: "tier1" } }] }));
};
await classifyIntent({ INTENT_SERVICE_URL: "http://capture/v1", INTENT_API_KEY: "x" }, "预热", { routeMode: "vps" });
') | ssh "${INTENT_SSH_HOST:-hetzner}" '
K=$(cat /root/hzdv/services/intent/.intent_api_key)
curl -s -m 90 http://127.0.0.1:8090/v1/chat/completions \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d @- -o /dev/null -w "warmup http=%{http_code} %{time_total}s\n"
docker logs --tail 6 hzdv-intent 2>&1 | grep "prompt eval time" | tail -1
'
