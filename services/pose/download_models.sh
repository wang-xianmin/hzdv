#!/usr/bin/env bash
# 下载 Ultralytics YOLOv8-Pose，并导出 ONNX（与 OCR 一样用 ONNX Runtime 推理）
#
# 用法：
#   cd services/pose && ./download_models.sh
#   ./download_models.sh n          # 默认，yolov8n-pose（约 6MB pt / ~13MB onnx）
#   ./download_models.sh s          # yolov8s-pose，更准更慢
#   ./download_models.sh m          # yolov8m-pose
#
# 官方权重：
#   https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n-pose.pt
#   https://docs.ultralytics.com/tasks/pose/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="${POSE_MODELS_DIR:-$ROOT/models}"
SIZE="${1:-n}"
NAME="yolov8${SIZE}-pose"
PT_URL="https://github.com/ultralytics/assets/releases/download/v8.2.0/${NAME}.pt"

mkdir -p "$MODELS_DIR"
cd "$MODELS_DIR"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd python3

case "$SIZE" in
  n|s|m|l|x) ;;
  *)
    echo "未知尺寸: $SIZE（可用 n|s|m|l|x）" >&2
    exit 1
    ;;
esac

echo "==> 下载 ${NAME}.pt"
if [[ -f "${NAME}.pt" ]]; then
  echo "    已存在，跳过: ${NAME}.pt"
else
  curl -fL --retry 3 --retry-delay 2 -o "${NAME}.pt" "$PT_URL"
fi

echo "==> 导出 ONNX（ultralytics，一次性）"
if [[ -f "${NAME}.onnx" ]]; then
  echo "    已存在，跳过: ${NAME}.onnx"
else
  EXPORT_VENV="${MODELS_DIR}/.export-venv"
  if [[ ! -x "$EXPORT_VENV/bin/python" ]]; then
    echo "    创建临时 venv 用于导出…"
    python3 -m venv "$EXPORT_VENV"
    "$EXPORT_VENV/bin/pip" install -q --upgrade pip
    "$EXPORT_VENV/bin/pip" install -q "ultralytics>=8.2.0,<9" onnx onnxruntime opencv-python-headless onnxslim
  fi
  POSE_EXPORT_NAME="$NAME" "$EXPORT_VENV/bin/python" - <<'PY'
import os
from pathlib import Path
from ultralytics import YOLO

name = os.environ["POSE_EXPORT_NAME"]
pt = Path(f"{name}.pt")
model = YOLO(str(pt))
out = model.export(format="onnx", imgsz=640, simplify=True, opset=12)
print("exported:", out)
PY
fi

ln -sfn "${NAME}.onnx" active.onnx
ln -sfn "${NAME}.pt" active.pt

cat > active.json <<EOF
{
  "kind": "yolov8_pose",
  "name": "${NAME}",
  "onnx": "${NAME}.onnx",
  "pt": "${NAME}.pt",
  "imgsz": 640,
  "task": "pose",
  "keypoints": 17,
  "keypoint_names": [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle"
  ]
}
EOF

echo "==> 当前模型: models/active.onnx -> ${NAME}.onnx"
echo "下一步: docker compose up -d --build"
echo "健康检查: curl http://127.0.0.1:8093/health"
