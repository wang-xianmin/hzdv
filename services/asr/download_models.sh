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
#   ./download_models.sh streaming            # SenseVoice Small ONNX + Silero VAD 模拟流式（唯一推荐）
#   ./download_models.sh all                  # SenseVoice int8 + VAD + 模拟流式配置
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
  streaming|streaming-sensevoice|streaming-sv)
    # 官方推荐的 SenseVoice「流式」= Silero VAD + 离线 SenseVoice Small（模拟流式）
    # 先保证离线 SenseVoice 与 VAD 存在
    if [[ ! -f "$MODELS_DIR/active.json" ]]; then
      "$0" sensevoice-int8
    fi
    if [[ ! -f "$MODELS_DIR/silero_vad.onnx" ]]; then
      "$0" vad
    fi
    # 从 active.json 读 SenseVoice 目录
    SV_DIR="$(python3 -c "import json;print(json.load(open('$MODELS_DIR/active.json'))['dir'])" 2>/dev/null || true)"
    if [[ -z "$SV_DIR" ]]; then
      SV_DIR="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    fi
    SV_MODEL="model.int8.onnx"
    if [[ ! -f "$MODELS_DIR/$SV_DIR/$SV_MODEL" ]]; then
      SV_MODEL="model.onnx"
    fi
    cat > "$MODELS_DIR/streaming.json" <<EOF
{
  "kind": "sense_voice_simulate",
  "dir": "$SV_DIR",
  "model": "$SV_MODEL",
  "tokens": "tokens.txt",
  "vad": "silero_vad.onnx",
  "sample_rate": 16000
}
EOF
    echo "==> SenseVoice 模拟流式: models/streaming.json (dir=$SV_DIR, vad=silero_vad.onnx)"
    echo "    说明: SenseVoice 无真正 Online 权重；官方流式版 = VAD 断句 + 离线 SenseVoice 边缓冲边上屏"
    ;;
  streaming-bilingual|streaming-zh-en)
    # 真 OnlineRecognizer：中英双语 Zipformer transducer
    NAME="sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    DIR="$MODELS_DIR/$NAME"
    pick_one() {
      local pattern="$1"
      local f
      f="$(ls $DIR/$pattern 2>/dev/null | head -1 || true)"
      basename "${f:-}"
    }
    ENC="$(pick_one 'encoder*.onnx')"
    DEC="$(pick_one 'decoder*.onnx')"
    JOI="$(pick_one 'joiner*.onnx')"
    if [[ -f "$DIR/encoder-epoch-99-avg-1.int8.onnx" ]]; then
      ENC="encoder-epoch-99-avg-1.int8.onnx"
    fi
    if [[ -f "$DIR/decoder-epoch-99-avg-1.int8.onnx" ]]; then
      DEC="decoder-epoch-99-avg-1.int8.onnx"
    fi
    if [[ -f "$DIR/joiner-epoch-99-avg-1.int8.onnx" ]]; then
      JOI="joiner-epoch-99-avg-1.int8.onnx"
    fi
    if [[ -z "$ENC" || -z "$DEC" || -z "$JOI" ]]; then
      echo "未在 $NAME 中找到 encoder/decoder/joiner" >&2
      ls -lh "$DIR" | head -40 >&2
      exit 1
    fi
    cat > "$MODELS_DIR/streaming.json" <<EOF
{
  "kind": "transducer",
  "dir": "$NAME",
  "encoder": "$ENC",
  "decoder": "$DEC",
  "joiner": "$JOI",
  "tokens": "tokens.txt",
  "sample_rate": 16000
}
EOF
    echo "==> 流式双语 Zipformer: models/streaming.json ($ENC / $DEC / $JOI)"
    ;;
  streaming-ctc|streaming-zh)
    # 仅中文 CTC int8（体积小，英文弱）
    NAME="sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01"
    download_tar "$RELEASE_BASE/${NAME}.tar.bz2"
    MODEL_FILE=""
    for cand in \
      "ctc-epoch-20-avg-1-chunk-16-left-128.int8.onnx" \
      "model.int8.onnx" \
      "ctc.int8.onnx"
    do
      if [[ -f "$MODELS_DIR/$NAME/$cand" ]]; then
        MODEL_FILE="$cand"
        break
      fi
    done
    if [[ -z "$MODEL_FILE" ]]; then
      MODEL_FILE="$(basename "$(ls "$MODELS_DIR/$NAME"/*.onnx 2>/dev/null | head -1)")"
    fi
    if [[ -z "$MODEL_FILE" || "$MODEL_FILE" == "." ]]; then
      echo "未在 $NAME 中找到 onnx 模型" >&2
      exit 1
    fi
    cat > "$MODELS_DIR/streaming.json" <<EOF
{
  "kind": "zipformer2_ctc",
  "dir": "$NAME",
  "model": "$MODEL_FILE",
  "tokens": "tokens.txt",
  "sample_rate": 16000
}
EOF
    echo "==> 流式中文 CTC: models/streaming.json (model=$MODEL_FILE)"
    ;;
  all)
    "$0" sensevoice-int8
    "$0" vad
    "$0" streaming
    ;;
  *)
    echo "未知目标: $TARGET" >&2
    echo "可选: sensevoice-int8 | sensevoice-fp32 | sensevoice-2025 | whisper-tiny.en | vad | streaming | streaming-bilingual | streaming-ctc | all" >&2
    exit 1
    ;;
esac

echo
echo "模型目录: $MODELS_DIR"
ls -lh "$MODELS_DIR" | head -40
echo
echo "下一步: docker compose up -d --build"
echo "健康检查: curl http://127.0.0.1:8091/health"
