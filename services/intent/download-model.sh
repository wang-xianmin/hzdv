#!/usr/bin/env bash
# 下载 Qwen2.5-1.5B-Instruct Q4_K_M GGUF（约 1.1G）到 ./models
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models
FILE=models/qwen2.5-1.5b-instruct-q4_k_m.gguf
if [ -s "$FILE" ]; then
  echo "already exists: $FILE ($(du -h "$FILE" | cut -f1))"
  exit 0
fi
URL="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf?download=true"
echo "downloading $URL"
curl -L --fail --retry 3 -o "$FILE.part" "$URL"
mv "$FILE.part" "$FILE"
echo "done: $(du -h "$FILE" | cut -f1)"
