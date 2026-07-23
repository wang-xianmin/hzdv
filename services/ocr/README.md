# hzdv OCR 服务（Python + RapidOCR + ONNX Runtime）

一套 Docker 镜像，VPS 上跑一份，Mac / 两个 Cloudflare 项目都调它。

## 架构

```text
Mac 开发 ──┐
VPS 本仓库 ─┼── docker compose → hzdv-ocr:8089
CF 项目 A ──┤         ▲
CF 项目 B ──┘         │
              OCR_SERVICE_URL + 可选 OCR_API_KEY
```

Cloudflare Pages **不**内嵌 Python；通过 `functions/api/ocr.js` 代理到本服务。

## 本地 / VPS 启动

```bash
cd services/ocr
# 可选：设置访问密钥
export OCR_API_KEY='换成你的密钥'
docker compose up -d --build
curl http://127.0.0.1:8089/health
```

识别示例：

```bash
curl -X POST http://127.0.0.1:8089/ocr \
  -H "X-API-Key: $OCR_API_KEY" \
  -F "file=@/path/to/image.jpg"
```

返回大致为：

```json
{
  "success": true,
  "text": "识别出的全文",
  "lines": [{ "text": "...", "score": 0.98, "box": [...] }],
  "line_count": 1,
  "elapse": [...]
}
```

## Cloudflare Pages 环境变量

在 Pages → Settings → Environment variables 配置：

| 变量 | 说明 |
|------|------|
| `OCR_SERVICE_URL` | 如 `http://你的VPS公网IP:8089` 或域名 `https://ocr.example.com` |
| `OCR_API_KEY` | 与容器 `OCR_API_KEY` 一致（可选但建议生产开启） |

前端只请求同源 `/api/ocr`，不要把密钥写进浏览器。

## Mac 与 VPS 共享

1. **同镜像**：两边都 `docker build -t hzdv-ocr:latest`（或以后推到 GHCR 再 `docker pull`）
2. **同协议**：都打 `/ocr`、`/health`
3. Mac 可：
   - 本地 `compose up`（`OCR_SERVICE_URL=http://127.0.0.1:8089`），或
   - 直接指向 VPS 上已运行的服务

## 推送到镜像仓库（可选，两台机器共用）

```bash
docker tag hzdv-ocr:latest ghcr.io/<org>/hzdv-ocr:latest
docker push ghcr.io/<org>/hzdv-ocr:latest
```

另一台：

```bash
docker pull ghcr.io/<org>/hzdv-ocr:latest
# compose 里 image: ghcr.io/<org>/hzdv-ocr:latest
```

## 安全建议

- 生产务必设 `OCR_API_KEY`
- VPS 防火墙仅放行需要的来源，或前面加 Nginx + HTTPS
- 不要对公网裸奔无密钥的 8089
