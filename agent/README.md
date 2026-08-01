# hzdv Agent 包（可移植）

把 AI 助手从前端到 Pages Functions 收拢在本目录，便于拷到另一个 Cloudflare Pages 项目。

## 目录

```text
agent/
  public/                 # 浏览器脚本与样式
    ai-assist.js
    ai-assist.css
    ai-assist-models.js
  functions/
    api/
      llm-models.js       # /api/llm-models
      llm-ping.js         # /api/llm-ping 试通
      ocr.js              # /api/ocr 代理
    lib/
      llm-models-store.js
      openai-compat.js    # OpenAI 兼容 chat/completions
      host.js             # ★ 宿主适配（KV / 运维鉴权）
  README.md
```

本仓库根目录仅保留薄入口，供 Cloudflare 识别路由：

- `functions/api/llm-models.js` → re-export `agent/functions/api/llm-models.js`
- `functions/api/llm-ping.js` → re-export `agent/functions/api/llm-ping.js`
- `functions/api/llm-chat.js` → re-export `agent/functions/api/llm-chat.js`
- `functions/api/ocr.js` → re-export `agent/functions/api/ocr.js`
- `functions/api/asr.js` → re-export `agent/functions/api/asr.js`
- `functions/api/llm-plan.js` → re-export `agent/functions/api/llm-plan.js`（失败恢复规划）
- `functions/api/llm-recover-log.js` → re-export `agent/functions/api/llm-recover-log.js`（恢复打点）
- `functions/api/llm-websearch-refine.js` → re-export（运维：联网检索改写规则）
- `functions/api/translate-turn.js` → re-export `agent/translator/functions/api/translate-turn.js`

面对面口译（按住说话）见独立包：[`translator/README.md`](./translator/README.md)。

## 接入本站

`index.html`：

```html
<link rel="stylesheet" href="agent/public/ai-assist.css?v=..." />
<script src="agent/public/ai-assist-models.js?v=..."></script>
<script src="agent/public/ai-assist.js?v=..."></script>
```

## 拷到另一项目

1. 复制整个 `agent/` 目录  
2. 在目标项目根建同样的 `functions/api/*.js` re-export（或把 `agent/functions/api` 内容链过去）  
3. **改 `agent/functions/lib/host.js`**：导出该项目的 `pickKvBinding` / `assertOpsAccess`（或等价实现）  
4. 配置环境变量（示例）：

| 变量 | 用途 |
|------|------|
| `ARK_API_KEY` / `DOUBAO_SEED_MODEL` | 第一梯队 Doubao（中文首选 / 英文备选）。`DOUBAO_SEED_MODEL` 填方舟接入点 ID（`ep-…`）或型号名；可选 `DOUBAO_LABEL` 改显示名 |
| `SILICONFLOW_API_KEY` / `QWEN_BASE_URL` / `QWEN_LITE_MODEL` | 第一梯队 Qwen（英文首选 / 中文备选；默认 `Qwen/Qwen2.5-7B-Instruct`） |
| `ALIYUN_MAAS_API_KEY` | 阿里 MaaS（二/三梯队多数模型） |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 |
| `OCR_SERVICE_URL` / `OCR_API_KEY` | OCR 代理 |
| `ASR_SERVICE_URL` / `ASR_API_KEY` | ASR（sherpa-onnx）代理 |
| `INTENT_SERVICE_URL` / `INTENT_API_KEY` | 意图分类（VPS llama.cpp） |
| `LLM_PROXY_SERVICE_URL` / `LLM_PROXY_API_KEY` | **可选**。③ 生成经 VPS 长超时转发云端 LLM（见 `services/llm-proxy/`）。未配则 CF 直连云厂商 |
| `TAVILY_API_KEY` | 联网检索密钥（Secret）。条数/深度在**系统设置 → 联网检索**调，也可被 env `TAVILY_MAX_RESULTS` / `TAVILY_SEARCH_DEPTH` 兜底 |
| 各模型 `apiKeyEnv` 指向的 Secret | 第二/三梯队 |

5. 绑定 KV（模型库存在键 `hzdv:llm_models_v1`，可按项目改 store 内常量）

## 与 OCR 服务的关系

Python + RapidOCR + ONNX Runtime 跑在仓库 `services/ocr/`（Docker，VPS `ocr.hzdv.net:8089`）。

当前链路（先看原文，再接 LLM）：

1. 浏览器上传/粘贴图 → Pages `/api/ocr`（代理 + Key）
2. VPS RapidOCR 返回纯文本
3. Agent 对话气泡写出 **`【RapidOCR】识别结果：…`**，并预填输入框  
   → 此时**尚未**送进任何 LLM；后续 chat 网关可把这段当 user 上下文再走梯队。

`agent` 只含 OCR **HTTP 代理**；多项目可共用同一 `OCR_SERVICE_URL`。

## 与 ASR 服务的关系

Python + sherpa-onnx（Next-gen Kaldi ONNX）跑在仓库 `services/asr/`（Docker，默认端口 `8090`）。

1. 先 `cd services/asr && ./download_models.sh` 下载免费 SenseVoice 等模型  
2. `docker compose up -d --build`  
3. Pages 配 `ASR_SERVICE_URL` / `ASR_API_KEY`，浏览器走同源 `/api/asr`  
4. AI 助手麦克风：点一下开始录音（按钮变红脉冲），再点结束 → 识别结果写入输入框；也可上传 wav/mp3 等音频文件  

与 OCR 一样：CF 上只跑代理，模型与推理在 VPS；多个 CF 项目可共用同一 ASR 服务。

## 与 LLM Proxy 的关系

③ 生成默认由 CF 直连 SiliconFlow / 豆包等。若配置了 `LLM_PROXY_*`：

```text
浏览器 → CF /api/llm-chat → VPS :8092/v1 → 云端 LLM
```

- 仓库：`services/llm-proxy/`（Docker，默认 `8092`）
- 云厂商密钥仍在 CF Secrets；VPS 用 `X-Upstream-*` 头转发，上游超时默认 120s
- 意图分类器（`INTENT_*`）不走本代理

## 失败恢复编排（Auto）

现有 ①意图 → ②搜网 → ③生成 不变。若 ③ 出现 HTML 502 / 软超时：

1. 前端识别墙钟失败  
2. `POST /api/llm-recover-log`（短打点，可失败忽略）  
3. `POST /api/llm-plan`：tier2（否则 tier1）输出最多 4 步 JSON（`websearch` / `generate`）  
4. 按步骤逐个短请求执行；**每轮对话最多自动恢复一次**

系统参数 → AI助手 → `llmForceFailGenerate=1`：跳过真实③，直接模拟墙钟失败以测恢复（测完改回 0）。

## Auto 选模与回复语言

两件事互不相干：

| | 依据 |
|---|---|
| 第一梯队主备顺序 | **菜单语言**：中文 → Doubao 首选 / Qwen 备选；英文 → Qwen 首选 / Doubao 备选 |
| 回复语言 | **提问语言**（后端按中日韩字符 / 拉丁字母判定），与菜单无关 |

主模型失败或未配置时自动试备选，再不行落第二/三梯队；气泡下方会显示跳过或失败原因，便于调试。

## 模型试通

系统运维 → AI 模型库：

- 顶栏「试通 Doubao / SiliconFlow」：第一梯队内置
- 每张卡片「试通」：保存当前 baseUrl 后调 `/api/llm-ping`
- 「重置默认种子」：覆盖 KV 为推荐配置（含阿里 `…/compatible-mode/v1`）

## 边界

| 在 agent 内 | 留在宿主项目 |
|-------------|--------------|
| 助手 UI、模型库 API、OCR 代理 | 登录、`phone` 运维鉴权实现、站点品牌与顶栏「系统运维 → AI 模型库」入口 |
| OpenAI 兼容调用（后续 chat 网关） | D1/R2 等非 agent 绑定 |

开发调试阶段：任意登录用户可进模型库；正式收紧为仅超级用户（前端入口 + `/api/llm-models` 写鉴权）。
