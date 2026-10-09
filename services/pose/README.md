# hzdv Pose / 文档扫描服务（YOLOv8-Pose + ONNX + OpenCV）

一套 Docker 镜像，VPS 上跑一份，Mac / 多个 Cloudflare 项目都调它。  
运行时只用 **ONNX Runtime**（与 RapidOCR 一致，不装 torch）。  
权重来自 [Ultralytics YOLOv8-Pose](https://docs.ultralytics.com/tasks/pose/)（COCO 17 人体关键点）。

默认模型：**yolov8n-pose**（导出 ONNX，约十几 MB）。

## 能做什么

| 接口 | 用途 |
|------|------|
| `POST /pose` | 人体姿态：框 + 17 关键点（手机对准人也能用） |
| `POST /scan` | **扫描全能王式**：找文档四角 → 透视拉正 → 增强，返回扫描图 base64 |

`/scan` 当前用 OpenCV 轮廓找四边形（开箱即用）。之后若你自训「文档四角」YOLO-Pose，可把模型放进 `models/` 再接到 `/scan`。

## 架构

```text
Mac 开发 ──┐
VPS 本仓库 ─┼── docker compose → hzdv-pose:8093
CF 项目 A ──┤         ▲
CF 项目 B ──┘         │
              POSE_SERVICE_URL + 可选 POSE_API_KEY
```

Cloudflare Pages **不**内嵌 Python；通过 `agent` 包的 `/api/pose` 代理到本服务（与 OCR/ASR 同模式）。

## 1. 下载模型

```bash
cd services/pose
chmod +x download_models.sh
./download_models.sh              # yolov8n-pose.pt → .onnx
# ./download_models.sh s          # 更大更准
```

模型落在 `models/`（已 gitignore，勿提交大文件）。

官方来源：https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n-pose.pt

## 2. 本地 / VPS 启动

```bash
cd services/pose
# 推荐：echo 'POSE_API_KEY=换成你的密钥' > .env
docker compose up -d --build
curl http://127.0.0.1:8093/health
# ufw allow 8093/tcp comment hzdv-pose
```

**加固**：见 [`../tunnel/README.md`](../tunnel/README.md)（可加 `pose.hzdv.net` → `127.0.0.1:8093`）。

姿态示例：

```bash
curl -X POST http://127.0.0.1:8093/pose \
  -H "X-API-Key: $POSE_API_KEY" \
  -F "file=@/path/to/person.jpg"
```

扫描示例：

```bash
curl -X POST http://127.0.0.1:8093/scan \
  -H "X-API-Key: $POSE_API_KEY" \
  -F "file=@/path/to/doc.jpg" \
  -F "enhance=auto"
```

`enhance`：`auto`（默认）| `color` | `gray` | `binary`。

手机手点四角（推荐）：传 `corners=[[x,y],[x,y],[x,y],[x,y]]`，服务端默认做 **Shi-Tomasi 邻域吸附 + `cornerSubPix` 亚像素精修**，把手指偏差吸到清晰边缘交点。`refine=false` 可关掉。

```bash
curl -X POST http://127.0.0.1:8093/scan/base64 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $POSE_API_KEY" \
  -d '{"image":"<base64>","corners":[[80,120],[400,90],[430,520],[60,550]],"enhance":"auto"}'
```

返回里 `corners` 为精修后坐标，`corners_seed` 为手点/自动种子，`corner_refine_detail` 含每点位移与方法。

## Cloudflare Pages 环境变量

| 变量 | 说明 |
|------|------|
| `POSE_SERVICE_URL` | **必须用域名**（Workers/Pages 不能 `fetch` 裸 IP）。例：`https://pose.hzdv.net` 或 `http://ocr.hzdv.net:8093` |
| `POSE_API_KEY` | 与容器 `POSE_API_KEY` 一致（Secret） |

前端只请求同源 `/api/pose`，不要把密钥写进浏览器。

## 与 OCR / ASR 对照

| | OCR | ASR | **Pose/Scan** |
|--|-----|-----|---------------|
| 目录 | `services/ocr` | `services/asr` | **`services/pose`** |
| 端口 | 8089 | 8091 | **8093** |
| CF 代理 | `/api/ocr` | `/api/asr` | **`/api/pose`** |
| Env | `OCR_SERVICE_URL` | `ASR_SERVICE_URL` | **`POSE_SERVICE_URL`** |

## 拷到另一项目

1. 复制整个 `services/pose/`（含 `download_models.sh`）  
2. 在目标项目加 `functions/api/pose.js` → re-export `agent/functions/api/pose.js`  
3. 配置 `POSE_SERVICE_URL` / `POSE_API_KEY`  
4. VPS 上只需跑**一份** `hzdv-pose`，多个 CF 项目都指向它  

## 安全建议

- 生产务必设 `POSE_API_KEY`
- Tunnel 通了之后端口只绑 `127.0.0.1:8093`
- 不要对公网裸奔无密钥的 8093

## VPS 现行部署（2026-10-09）

```text
pose.hzdv.net ─Tunnel→ 127.0.0.1:8093 → hzdv-pose 容器:8093
```

- compose 发布 `127.0.0.1:8093:8093`（Docker 发布端口绕过 UFW，必须绑 127.0.0.1）。
- `pose_debug_proxy.py` 已于 2026-10-09 下线，文件保留仅作回滚：回滚 = compose 改回 `127.0.0.1:18093:8093` 并 `docker compose up -d`，再 `cd services/pose && nohup python3 -u pose_debug_proxy.py 8093 >> logs/proxy_stdout_v6i.log 2>&1 &`。
- 容器不再落盘原图，只在容器内 `/tmp/pose_last_resp.json` 保留最近一次响应。
- 前端 ratio 校准参数（`calib_mode=ratio`）目前服务端不处理（另单跟进）；abs 偏移由前端本地叠加。

`models/active.onnx`（软链接）与 `.onnx`/`.pt` 权重不入库；当前模型元数据见 `models/a4_pose_kg84_agg84_20261003.json`。
