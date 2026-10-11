# hzdv LLM 代理（VPS 长超时转发云端 OpenAI 兼容 API）

CF Pages 的 ③ 生成不再直连 SiliconFlow / 豆包等，而是：

```text
浏览器 → CF /api/llm-chat → https://llm.hzdv.net/v1（Tunnel）→ 云端 LLM
```

云厂商密钥仍在 **Cloudflare Secrets**；VPS 只做鉴权 + 长超时 `httpx` 转发（默认上游 180s）。
`stream: true` 时**透传上游 SSE**（配合 CF 侧 Agents 式流式生成，破同步墙钟）。
意图分类器（llama.cpp 1.5B）**不走**本服务。

**加固**：见 [`../tunnel/README.md`](../tunnel/README.md)。

## 端口

| 服务 | 端口 |
|------|------|
| OCR | 8089 |
| Intent | 8090 |
| ASR | 8091 |
| **LLM Proxy** | **8092** |
| Pose / Scan | 8093 |

## VPS 启动

```bash
cd services/llm-proxy
[ -s .env ] || echo "LLM_PROXY_API_KEY=$(openssl rand -hex 16)" > .env
docker compose up -d --build
curl http://127.0.0.1:8092/health
# 未上 Tunnel 时：
ufw allow 8092/tcp comment hzdv-llm-proxy
```

## Cloudflare Pages 环境变量

| 变量 | 值 |
|------|----|
| `LLM_PROXY_SERVICE_URL` | `https://llm.hzdv.net/v1`（Tunnel；旧：`http://ocr.hzdv.net:8092/v1`） |
| `LLM_PROXY_API_KEY` | 与 `.env` 中一致（Secret） |

原有 `SILICONFLOW_API_KEY` / `ARK_API_KEY` 等 **仍配在 CF**；代理请求会带上 `X-Upstream-*` 头。

未配置 `LLM_PROXY_SERVICE_URL` 时，行为与以前相同（CF 直连云端）。

## 内置模型 ds-ocr / ds-ocr-thinking（Cursor / Trae 添加模型）

| 模型 | 上游 |
|------|------|
| `ds-ocr` | DeepSeek `deepseek-flash`，非思考（`thinking: disabled`） |
| `ds-ocr-thinking` | DeepSeek `deepseek-flash`，思考（`thinking: enabled`） |

消息里的图片（base64 data URL）先由同机 `hzdv-ocr` 识别成文字（小图放大到长边约 2000px，按图片哈希缓存）再送模型；不抓取 http(s) 图片地址。工具调用、流式原样透传。

`.env` 追加（均为 Secret，勿提交）：

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（服务端持有） |
| `DS_OCR_API_KEY` | 客户端密钥，填在 Cursor / Trae 的 API Key 里（`LLM_PROXY_API_KEY` 也可用） |
| `DS_OCR_OCR_API_KEY` | 与 `../ocr/.env` 的 `OCR_API_KEY` 一致 |
| `DS_OCR_OCR_URL` | 默认 `http://host.docker.internal:8089` |

客户端配置：Base URL `https://llm.hzdv.net/v1`，API Key 填 `DS_OCR_API_KEY`，模型名 `ds-ocr` / `ds-ocr-thinking`。Cursor 的模型设置是全局的，所有项目共用。

```bash
curl -s https://llm.hzdv.net/v1/models -H "Authorization: Bearer $DS_OCR_API_KEY"
```

## 冒烟

```bash
curl -s http://127.0.0.1:8092/v1/chat/completions \
  -H "Authorization: Bearer $(grep LLM_PROXY_API_KEY .env | cut -d= -f2)" \
  -H "X-Upstream-Base-Url: https://api.siliconflow.cn/v1" \
  -H "X-Upstream-Api-Key: $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"只回复pong"}],"max_tokens":16}'
```
