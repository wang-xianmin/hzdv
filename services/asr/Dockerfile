# ASR 运行时：Python + sherpa-onnx（Next-gen Kaldi ONNX）
# 构建：docker build -t hzdv-asr:latest .
# 运行前请先：./download_models.sh

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ASR_HOST=0.0.0.0 \
    ASR_PORT=8090 \
    ASR_MODELS_DIR=/app/models

WORKDIR /app

# soundfile / onnxruntime 常用系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 \
      libgomp1 \
      curl \
      bzip2 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app.py .
COPY download_models.sh .
RUN chmod +x download_models.sh

# 模型通过 volume 挂载；也可在构建后进容器执行 download_models.sh
RUN mkdir -p /app/models

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
