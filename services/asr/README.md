# hzdv ASR 服务（Python + sherpa-onnx / Next-gen Kaldi）

一套 Docker 镜像，VPS 上跑一份，Mac / 两个 Cloudflare 项目都调它。  
模型来自 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 官方免费开源发布（ONNX）。

默认模型：**SenseVoice Small int8**（中/英/日/韩/粤），约 230MB。

## 架构

```text
Mac 开发 ──┐
VPS 本仓库 ─┼── docker compose → hzdv-asr:8091
CF 项目 A ──┤         ▲
CF 项目 B ──┘         │
              ASR_SERVICE_URL + 可选 ASR_API_KEY
```

Cloudflare Pages **不**内嵌 Python / ONNX 大模型；通过 `agent` 包的 `/api/asr` 代理到本服务（与 OCR 同模式）。

## 1. 下载模型

```bash
cd services/asr
chmod +x download_models.sh
./download_models.sh              # SenseVoice int8（推荐）
# ./download_models.sh all        # + Silero VAD
# ./download_models.sh whisper-tiny.en
```

模型落在 `models/`（已 gitignore，勿提交大文件）。

官方来源：

- Releases：https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models  
- SenseVoice 说明：https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html  

## 2. 本地 / VPS 启动

```bash
cd services/asr
# 推荐：echo 'ASR_API_KEY=换成你的密钥' > .env
docker compose up -d --build
curl http://127.0.0.1:8091/health
ufw allow 8091/tcp comment hzdv-asr
```

识别示例：

```bash
curl -X POST http://127.0.0.1:8091/asr \
  -H "X-API-Key: $ASR_API_KEY" \
  -F "file=@/path/to/audio.wav"
```

返回大致为：

```json
{
  "success": true,
  "text": "识别出的文字",
  "lang": "<|zh|>",
  "engine": "sherpa-onnx",
  "model": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
  "elapsed_sec": 0.4
}
```

推荐音频：16 kHz 单声道 wav/flac/ogg。其它采样率会在服务内线性重采样。

## 真流式（可选）

SenseVoice Small **没有**真正的 Online 流式权重。本服务的「流式」固定为：

**Silero VAD + SenseVoice Small ONNX**（边缓冲边识别，模拟流式；中英日韩粤）

```bash
cd services/asr
./download_models.sh sensevoice-int8   # 若尚未下载离线模型
./download_models.sh vad
./download_models.sh streaming         # 写入 streaming.json = sense_voice_simulate
docker compose up -d --build
curl http://127.0.0.1:8091/health      # streaming_mode=sense_voice_simulate
```

不再使用 Zipformer Online / CTC 作为默认流式后端。

- HTTP 会话：`POST /asr/stream`（`action=start|audio|end`），经 CF `/api/asr` 代理  
- WebSocket：`/asr/ws`（浏览器可直连；Pages 配可选 `ASR_WS_URL`）

系统设置 `asrMicMode`：`0` 整段 / `1` VAD断句离线 / `2` 真流式（三选一，互斥）。

## Cloudflare Pages 环境变量

| 变量 | 说明 |
|------|------|
| `ASR_SERVICE_URL` | **必须用域名**（Workers/Pages 不能 `fetch` 裸 IP）。与 OCR 同机时用：`http://ocr.hzdv.net:8091` |
| `ASR_API_KEY` | 与容器 `ASR_API_KEY` 一致（Secret） |

DNS：可复用 `ocr.hzdv.net`（灰云）+ 端口 `8091`，不必新建子域。  
前端只请求同源 `/api/asr`，不要把密钥写进浏览器。

## 与 OCR / Intent 对照

| | OCR | Intent | ASR |
|--|-----|--------|-----|
| 目录 | `services/ocr` | `services/intent` | `services/asr` |
| 端口 | 8089 | 8090 | **8091** |
| CF 代理 | `/api/ocr` | 内嵌 llm-chat | `/api/asr` |
| 示例 URL | `http://ocr.hzdv.net:8089` | `http://ocr.hzdv.net:8090/v1` | `http://ocr.hzdv.net:8091` |

## 拷到另一项目

1. 复制整个 `services/asr/`（含 `download_models.sh`）  
2. 在目标项目加 `functions/api/asr.js` → re-export `agent/functions/api/asr.js`（或同步拷贝 agent 代理）  
3. 配置 `ASR_SERVICE_URL` / `ASR_API_KEY`  
4. VPS 上只需跑**一份** `hzdv-asr`，两个 CF 项目都指向它  

## 推送到镜像仓库（可选）

```bash
docker tag hzdv-asr:latest ghcr.io/<org>/hzdv-asr:latest
docker push ghcr.io/<org>/hzdv-asr:latest
```

注意：镜像默认**不含**模型权重；另一台仍需挂载已下载的 `models/`，或在容器内执行 `./download_models.sh`。

## 安全建议

- 生产务必设 `ASR_API_KEY`
- 防火墙仅放行需要来源，或前面加 Nginx + HTTPS
- 不要对公网裸奔无密钥的 8090
