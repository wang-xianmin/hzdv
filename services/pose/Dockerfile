# Pose / 扫描：YOLOv8-Pose + OpenCV
# 构建：docker build -t hzdv-pose:latest .
# 运行前请先：./download_models.sh

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    POSE_HOST=0.0.0.0 \
    POSE_PORT=8093 \
    POSE_MODELS_DIR=/app/models

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app.py .
COPY download_models.sh .
RUN chmod +x download_models.sh && mkdir -p /app/models

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8093/health', timeout=3)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8093"]
