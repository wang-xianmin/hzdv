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
      ocr.js              # /api/ocr 代理
    lib/
      llm-models-store.js
      host.js             # ★ 宿主适配（KV / 运维鉴权）
  README.md
```

本仓库根目录仅保留薄入口，供 Cloudflare 识别路由：

- `functions/api/llm-models.js` → re-export `agent/functions/api/llm-models.js`
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
| `ARK_API_KEY` / `DOUBAO_LITE_MODEL` | 第一梯队 / 分类器（豆包） |
| `QWEN_API_KEY` / `QWEN_BASE_URL` / `QWEN_LITE_MODEL` | 备份分类器（SiliconFlow 等） |
| `OCR_SERVICE_URL` / `OCR_API_KEY` | OCR 代理 |
| 各模型 `apiKeyEnv` 指向的 Secret | 第二/三梯队 |

5. 绑定 KV（模型库存在键 `hzdv:llm_models_v1`，可按项目改 store 内常量）

## 与 OCR 服务的关系

Python + RapidOCR 仍在仓库 `services/ocr/`（Docker，VPS 跑一份）。  
`agent` 只包含 **HTTP 代理** `/api/ocr`，多项目共用同一 `OCR_SERVICE_URL`。

## 边界

| 在 agent 内 | 留在宿主项目 |
|-------------|--------------|
| 助手 UI、模型库 API、OCR 代理 | 登录、`phone` 运维鉴权实现、站点品牌与顶栏入口 |
| OpenAI 兼容调用（后续 chat 网关） | D1/R2 等非 agent 绑定 |
