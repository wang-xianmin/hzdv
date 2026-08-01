# hzdv LLM 代理（VPS 长超时转发云端 OpenAI 兼容 API）

CF Pages 的 ③ 生成不再直连 SiliconFlow / 豆包等，而是：

```text
浏览器 → CF /api/llm-chat → VPS :8092/v1 → 云端 LLM
```

云厂商密钥仍在 **Cloudflare Secrets**；VPS 只做鉴权 + 长超时 `httpx` 转发（默认上游 120s）。
意图分类器（llama.cpp 1.5B）**不走**本服务。

## 端口

| 服务 | 端口 |
|------|------|
| OCR | 8089 |
| Intent | 8090 |
| ASR | 8091 |
| **LLM Proxy** | **8092** |

## VPS 启动

```bash
cd services/llm-proxy
[ -s .env ] || echo "LLM_PROXY_API_KEY=$(openssl rand -hex 16)" > .env
docker compose up -d --build
curl http://127.0.0.1:8092/health
# 防火墙
ufw allow 8092/tcp comment hzdv-llm-proxy
```

DNS：继续用 `ocr.hzdv.net` A 记录（灰云），换端口即可。

## Cloudflare Pages 环境变量

| 变量 | 值 |
|------|----|
| `LLM_PROXY_SERVICE_URL` | `http://ocr.hzdv.net:8092/v1`（必须域名，Workers 不能 fetch 裸 IP） |
| `LLM_PROXY_API_KEY` | 与 `.env` 中一致（Secret） |

原有 `SILICONFLOW_API_KEY` / `ARK_API_KEY` 等 **仍配在 CF**；代理请求会带上 `X-Upstream-*` 头。

未配置 `LLM_PROXY_SERVICE_URL` 时，行为与以前相同（CF 直连云端）。

## 冒烟

```bash
curl -s http://127.0.0.1:8092/v1/chat/completions \
  -H "Authorization: Bearer $(grep LLM_PROXY_API_KEY .env | cut -d= -f2)" \
  -H "X-Upstream-Base-Url: https://api.siliconflow.cn/v1" \
  -H "X-Upstream-Api-Key: $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"只回复pong"}],"max_tokens":16}'
```
