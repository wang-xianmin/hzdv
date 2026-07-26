# hzdv 意图分类服务（llama.cpp + Qwen2.5-1.5B-Instruct Q4_K_M）

与 `services/ocr` 同一套路：VPS 跑一份 Docker，多个 Cloudflare 项目共用。
对外是 **OpenAI 兼容接口**（`/v1/chat/completions`），既能做意图分类，也能当轻量本地 LLM 用。

## 架构

```text
CF 项目 A ──┐
CF 项目 B ──┼── http://ocr.hzdv.net:8090/v1 （llama.cpp server）
Mac 开发 ──┘        模型：Qwen2.5-1.5B-Instruct Q4_K_M（~1.1G，纯 CPU）
```

用途：`/api/llm-chat` Auto 模式先调它做**意图分类**（tier1 闲聊 / tier2 主力 / tier3 军师），
再把用户消息路由到对应梯队。分类失败时自动回退为原有的 tier1 主备顺序。

## VPS 启动

```bash
cd services/intent
# 1) 生成 API Key（勿提交）
[ -s .intent_api_key ] || openssl rand -hex 16 > .intent_api_key
echo "INTENT_API_KEY=$(cat .intent_api_key)" > .env
# 2) 下载模型（~1.1G，一次性）
./download-model.sh
# 3) 启动
docker compose up -d
curl http://127.0.0.1:8090/health
# 4) 防火墙
ufw allow 8090/tcp comment hzdv-intent
```

## 冒烟测试

```bash
curl -s http://127.0.0.1:8090/v1/chat/completions \
  -H "Authorization: Bearer $(cat .intent_api_key)" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-1.5b","messages":[{"role":"user","content":"你好"}],"max_tokens":32}'
```

## Cloudflare Pages 环境变量

| 变量 | 值 |
|------|----|
| `INTENT_SERVICE_URL` | `http://ocr.hzdv.net:8090/v1`（必须域名，Workers 不能 fetch 裸 IP） |
| `INTENT_API_KEY` | `.intent_api_key` 内容（Secret） |

## 资源占用

- 模型文件 ~1.1G（`./models`，已 gitignore）
- 运行内存 ~1.3–1.6G（compose 限 2G）
- 2 核 CPU 上分类（输出几个 token）通常 <1s
