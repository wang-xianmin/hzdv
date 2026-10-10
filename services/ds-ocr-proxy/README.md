# hzdv ds-ocr 代理（Cursor / Trae）

本机 OpenAI 兼容网关，对外暴露两个模型名：

| 模型 ID | 行为 |
|---------|------|
| **`ds-ocr`** | 有图 → OCR → DeepSeek；**关闭**思考 |
| **`ds-ocr-think`** | 有图 → OCR → DeepSeek；**开启**思考 |

```text
Cursor / Trae
   │  Override Base URL → http://127.0.0.1:8094/v1
   │  model = ds-ocr 或 ds-ocr-think
   ▼
ds-ocr-proxy (:8094)
   ├─ 消息含 image_url → OCR_SERVICE_URL + OCR_API_KEY
   └─ 文本 → DeepSeek（thinking enabled/disabled）
```

## 端口

| 服务 | 端口 |
|------|------|
| OCR | 8089 |
| Intent | 8090 |
| ASR | 8091 |
| LLM Proxy | 8092 |
| Pose | 8093 |
| **ds-ocr-proxy** | **8094** |

## 启动

先保证 OCR 在跑（`services/ocr`，默认 `8089`）。

```bash
cd services/ds-ocr-proxy
cp .env.example .env
# 编辑 .env：至少填 DEEPSEEK_API_KEY；建议填 DS_OCR_PROXY_API_KEY、OCR_API_KEY
docker compose up -d --build
curl http://127.0.0.1:8094/health
```

本机不用 Docker、直接跑：

```bash
cd services/ds-ocr-proxy
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DEEPSEEK_API_KEY=sk-...
export OCR_SERVICE_URL=http://127.0.0.1:8089
export OCR_API_KEY=...          # 若 OCR 开了鉴权
export DS_OCR_PROXY_API_KEY=... # 可选
uvicorn app:app --host 127.0.0.1 --port 8094
```

## Cursor

1. Settings → Models  
2. **OpenAI API Key** = `DS_OCR_PROXY_API_KEY`（未设则任意非空也可，建议设上）  
3. 打开 **Override OpenAI Base URL** = `http://127.0.0.1:8094/v1`  
4. 添加模型名：`ds-ocr`、`ds-ocr-think`  
5. 用自带订阅模型时：**关掉** Override OpenAI Base URL  

## Trae

自定义模型（每个模型单独配，不盖内置）：

| 项 | 值 |
|----|----|
| API 格式 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8094/v1` |
| 模型 ID | `ds-ocr` 或 `ds-ocr-think` |
| API Key | `DS_OCR_PROXY_API_KEY` |

## 冒烟

```bash
# 无图 + 关思考
curl -s http://127.0.0.1:8094/v1/chat/completions \
  -H "Authorization: Bearer $DS_OCR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ds-ocr","messages":[{"role":"user","content":"只回复pong"}],"max_tokens":16}'

# 模型列表
curl -s http://127.0.0.1:8094/v1/models \
  -H "Authorization: Bearer $DS_OCR_PROXY_API_KEY"
```

## 说明

- 图片仅做 OCR，**不会**把原图送给 DeepSeek（普通 `deepseek-flash` 不支持视觉）。  
- OCR 走本仓库 `services/ocr` 的 **`POST /ocr/base64`**（不是 multipart `/ocr`）。  
- 关思考：`thinking: {type: disabled}`；开思考：`enabled` + `reasoning_effort`（可用 env `DS_OCR_REASONING_EFFORT`）。  
- DeepSeek 密钥也可临时用请求头 `X-DeepSeek-Api-Key` 覆盖 env。  
