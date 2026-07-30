#!/usr/bin/env bash
# 下载 Next-gen Kaldi / sherpa-onnx 免费开源 ASR 模型到本目录 models/
# 默认：SenseVoice Small int8（中/英/日/韩/粤），约 230MB
#
# 用法：
#   cd services/asr && ./download_models.sh
#   ./download_models.sh sensevoice-int8      # 默认
#   ./download_models.sh sensevoice-fp32      # 更大 float32（含 int8）
#   ./download_models.sh whisper-tiny.en      # 英文极小 Whisper
#   ./download_models.sh vad                  # 仅 Silero VAD
#   ./download_models.sh all                  # SenseVoice int8 + VAD
#
# 官方发布页：
#   https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
#   https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="${ASR_MODELS_DIR:-$ROOT/models}"
RELEASE_BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

mkdir -p "$MODELS_DIR"
cd "$MODELS_DIR"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd tar

download_tar() {
  local url="$1"
  local archive
  archive="$(basename "$url")"
  echo "==> 下载 $archive"
  if [[ -f "$archive" ]]; then
    echo "    已存在归档，跳过下载（删除后可重下）: $archive"
  else
    curl -fL --retry 3 --retry-delay 2 -o "$archive" "$url"
  fi
  echo "==> 解压 $archive"
  tar xjf "$archive"
  echo "==> 完成"
}

download_file() {
  local url="$1"
  local out
  out="$(basename "$url")"
  echo "==> 下载 $out"
  if [[ -f "$out" ]]; then
    echo "    已存在，跳过: $out"
    return 0
  fi
  curl -fL --retry 3 --retry-delay 2 -o "$out" "$url"
}

write_active_link() {
  local name="$1"
  ln -sfn "$name" active
  echo "==> 当前默认模型链接: models/active -> $name"
  # 供 app.py 读取的轻量元数据
  cat > active.json <<EOF
{
  "kind": "sense_voice",
  "dir": "$name",
  "model": "model.int8.onnx",
  "tokens": "tokens.txt",
  "sample_rate": 16000
}
EOF
}

TARGET="${1:-sensevoice-int8}"

case "$TARGET" in
  sensevoice-int8|sensevoice|default)
    # 中英日韩粤，int8，约 228MB — VPS 推荐默认
    NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    write_active_link "$NAME"
    ;;
  sensevoice-2025|sensevoice-int8-2025)
    NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    write_active_link "$NAME"
    ;;
  sensevoice-fp32)
    NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    # fp32 包里也有 model.int8.onnx；默认仍用 int8 省内存
    write_active_link "$NAME"
    ;;
  whisper-tiny.en)
    NAME="sherpa-onnx-whisper-tiny.en"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    ln -sfn "$NAME" active
    cat > active.json <<EOF
{
  "kind": "whisper",
  "dir": "$NAME",
  "encoder": "tiny.en-encoder.onnx",
  "decoder": "tiny.en-decoder.onnx",
  "tokens": "tiny.en-tokens.txt",
  "sample_rate": 16000
}
EOF
    echo "==> 当前默认模型链接: models/active -> $NAME (whisper)"
    ;;
  vad)
    download_file "$RELEASE_BASE/silero_vad.onnx"
    ;;
  all)
    "$0" sensevoice-int8
    "$0" vad
    ;;
  *)
    echo "未知目标: $TARGET" >&2
    echo "可选: sensevoice-int8 | sensevoice-fp32 | sensevoice-2025 | whisper-tiny.en | vad | all" >&2
    exit 1
    ;;
esac

echo
echo "模型目录: $MODELS_DIR"
ls -lh "$MODELS_DIR" | head -40
echo
echo "下一步: docker compose up -d --build"
echo "健康检查: curl http://127.0.0.1:8091/health"
