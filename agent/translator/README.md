# Agent Translator（面对面口译 · 可移植）

手机/平板优先的 **按住说话** 翻译器：挂在宿主站点，按人员类型开放；可整目录拷到另一个 Cloudflare Pages 项目。

电脑端 AI 助手麦克风（点按）**不改**；本模块独立。

## 目录

```text
agent/translator/
  public/
    translator.html   # 独立页（Mac / 手机浏览器可测）
    translator.css
    translator.js
  functions/
    api/
      translate-turn.js   # POST /api/translate-turn
    lib/
      access.js           # 人员门禁（读宿主 host）
  README.md
```

宿主根目录薄入口：

- `functions/api/translate-turn.js` → re-export 本包 API

## 交互

| 按钮 | 按住时 | 松手后 |
|------|--------|--------|
| **我说** | 录中文 | ASR → 译英文 → 英文朗读 + 屏显 |
| **对方说** | 录对方话（多英文） | ASR → 译中文 → 中文朗读 + 屏显 |

显示可切换：双语 / 只中文 / 只英文。朗读用浏览器 `speechSynthesis`（前期够用；以后可换云 TTS）。

## 拷到另一项目

1. 复制整个 `agent/translator/`（以及共用的 `agent/functions/lib/host.js`、openai-compat、ASR 代理若尚未有）
2. 加 `functions/api/translate-turn.js` re-export
3. 改 `agent/translator/functions/lib/access.js`（或宿主 `translator-auth.js`）里的类型掩码
4. 配 `ASR_SERVICE_URL`、LLM Key（与 AI 助手相同即可）
5. 页面链到 `agent/translator/public/translator.html`

## 权限

默认与运维临时策略一致：**已登录即可用**（方便 Mac 联调）。  
正式收紧：在 `functions/lib/translator-auth.js` 把 `TRANSLATOR_TEMP_OPEN_TO_ANY_LOGIN` 设为 `false`，并用 `TRANSLATOR_TYPE_MASK` 限定 A/B/C 类等。

## 依赖

- 已有 `/api/asr`（VPS SenseVoice）
- LLM（方舟 / SiliconFlow / 模型库任一可用 Key）做翻译
