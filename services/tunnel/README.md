# hzdv Cloudflare Tunnel（加固 CF ↔ VPS）

把 OCR / Intent / ASR / LLM-Proxy **只绑本机**，经 Cloudflare Tunnel 暴露为 **HTTPS 域名**。  
公网可关掉 `8089–8092`，链路变为：

```text
浏览器 → CF Pages /api/* →（CF 内网）→ Tunnel → 127.0.0.1:808x
```

- 传输加密（不再明文 `http://ocr.hzdv.net:端口`）
- 不暴露 VPS 公网端口（降低扫端口与直连风险）
- Workers 继续用**域名**（不能裸 IP）

> 备选：本机 Nginx/Caddy + Let's Encrypt 源站 HTTPS，并 UFW 仅放行 Cloudflare IP。运维更重，本目录以 **Tunnel 为首选**。

## 子域名规划（推荐）

| 主机名 | 本机服务 | Pages Secret（示例） |
|--------|----------|----------------------|
| `ocr.hzdv.net` | `127.0.0.1:8089` | `OCR_SERVICE_URL=https://ocr.hzdv.net` |
| `intent.hzdv.net` | `127.0.0.1:8090` | `INTENT_SERVICE_URL=https://intent.hzdv.net/v1` |
| `asr.hzdv.net` | `127.0.0.1:8091` | `ASR_SERVICE_URL=https://asr.hzdv.net` |
| `llm.hzdv.net` | `127.0.0.1:8092` | `LLM_PROXY_SERVICE_URL=https://llm.hzdv.net/v1` |

可继续复用旧名，只要 Tunnel ingress 指对端口；**不要再带 `:8089` 端口号**。

## 一次性：创建 Tunnel

1. Cloudflare Dashboard → **Zero Trust** → Networks → Tunnels → Create  
2. 选 **Cloudflared**，记下 **Tunnel token**（勿提交 git）  
3. 为上表四个主机名添加 **Public Hostname**（或先用下面 `config.yml` + 手动 DNS CNAME）

DNS：每个主机名应是 **CNAME → `<tunnel-id>.cfargotunnel.com`**（橙云可开可关；走 Tunnel 时由 CF 终止 TLS）。

## VPS 启动 cloudflared

```bash
cd services/tunnel
cp .env.example .env
# 编辑 .env：填入 TUNNEL_TOKEN=...

# 若用本地 config 路由（可选；用 Token 托管路由时可省略 config 挂载）
cp config.yml.example config.yml
# 按需改 hostname

docker compose up -d
docker compose logs -f cloudflared
```

健康：Dashboard 里 Tunnel 为 **Healthy**；本机：

```bash
curl -sS https://ocr.hzdv.net/health
curl -sS https://intent.hzdv.net/health
curl -sS https://asr.hzdv.net/health
curl -sS https://llm.hzdv.net/health
```

（各服务仍要带各自的 `X-API-Key` / Bearer，与现在相同。）

## 收紧本机端口（Tunnel 通了之后）

各服务 `docker-compose.yml` 将端口改为只听本机，例如 OCR：

```yaml
ports:
  - "127.0.0.1:8089:8089"
```

Intent / ASR / llm-proxy 同理（`127.0.0.1:8090` 等）。

然后：

```bash
ufw delete allow 8089/tcp || true
ufw delete allow 8090/tcp || true
ufw delete allow 8091/tcp || true
ufw delete allow 8092/tcp || true
ufw status
```

确认外网 `telnet VPS_IP 8089` 不通，而 `https://ocr.hzdv.net/health` 仍通。

## Cloudflare Pages 环境变量

把原先的 `http://ocr.hzdv.net:8089` 等改成上表 **https、无端口**。密钥字段不变（`OCR_API_KEY`、`INTENT_API_KEY`、`ASR_API_KEY`、`LLM_PROXY_API_KEY`）。

改完后用系统运维 → 模型试通 / OCR·ASR 各打一次。

## 回滚

1. Pages Secrets 改回旧 `http://…:端口`  
2. compose 端口改回 `0.0.0.0` 发布并 `ufw allow`  
3. `docker compose -f services/tunnel/docker-compose.yml down`

## Token 安全

- `services/tunnel/.env` 已在 `.gitignore`  
- 勿把 Tunnel token 写进 README 或提交仓库  
- 泄露后在 Zero Trust 里 rotate token
