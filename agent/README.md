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
