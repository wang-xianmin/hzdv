"""HZDV ASR 微服务：Python + sherpa-onnx（Next-gen Kaldi ONNX）。

默认模型：SenseVoice Small int8（中/英/日/韩/粤），见 download_models.sh。

接口对齐 OCR 服务风格，便于 Cloudflare Pages 代理与多项目共用：
  GET  /health
  POST /asr          multipart: file=<audio>
  POST /asr/base64   JSON: { audio: "data:audio/...;base64,..." } 或纯 base64
"""

from __future__ import annotations

import base64
import io
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("ASR_MODELS_DIR", str(APP_DIR / "models"))).resolve()
API_KEY = (os.environ.get("ASR_API_KEY") or "").strip()
CORS_ORIGINS = (os.environ.get("ASR_CORS_ORIGINS") or "*").strip()
NUM_THREADS = int(os.environ.get("ASR_NUM_THREADS") or "2")
USE_ITN = (os.environ.get("ASR_USE_ITN") or "1").strip() not in ("0", "false", "False")
LANGUAGE = (os.environ.get("ASR_LANGUAGE") or "auto").strip() or "auto"

app = FastAPI(title="hzdv-asr", version="0.1.0")
_origins = ["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_recognizer = None
_model_meta: dict[str, Any] = {}


def _check_api_key(x_api_key: Optional[str]) -> None:
    if not API_KEY:
        return
    if not x_api_key or x_api_key.strip() != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


def _load_meta() -> dict[str, Any]:
    active_json = MODELS_DIR / "active.json"
    if active_json.is_file():
        return json.loads(active_json.read_text(encoding="utf-8"))
    # 兜底：扫描常见 SenseVoice 目录
    for name in sorted(MODELS_DIR.iterdir() if MODELS_DIR.is_dir() else []):
        if not name.is_dir():
            continue
        n = name.name
        if "sense-voice" in n and (name / "tokens.txt").is_file():
            model = "model.int8.onnx" if (name / "model.int8.onnx").is_file() else "model.onnx"
            if (name / model).is_file():
                return {
                    "kind": "sense_voice",
                    "dir": n,
                    "model": model,
                    "tokens": "tokens.txt",
                    "sample_rate": 16000,
                }
    raise FileNotFoundError(
        f"未找到 ASR 模型。请先在 {MODELS_DIR} 运行 ./download_models.sh"
    )


def get_recognizer():
    global _recognizer, _model_meta
    if _recognizer is not None:
        return _recognizer

    import sherpa_onnx

    meta = _load_meta()
    _model_meta = meta
    kind = str(meta.get("kind") or "sense_voice")
    model_dir = MODELS_DIR / str(meta["dir"])

    if kind == "whisper":
        encoder = str(model_dir / meta["encoder"])
        decoder = str(model_dir / meta["decoder"])
        tokens = str(model_dir / meta["tokens"])
        _recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=encoder,
            decoder=decoder,
            tokens=tokens,
            num_threads=NUM_THREADS,
            debug=False,
        )
    else:
        model = str(model_dir / meta["model"])
        tokens = str(model_dir / meta["tokens"])
        _recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model,
            tokens=tokens,
            num_threads=NUM_THREADS,
            language=LANGUAGE,
            use_itn=USE_ITN,
            debug=False,
        )
    return _recognizer


def _load_audio_bytes(data: bytes) -> tuple[np.ndarray, int]:
    """返回 float32 mono samples + sample_rate。"""
    import soundfile as sf

    try:
        samples, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    except Exception:
        # 部分容器（webm/m4a）soundfile 读不了时，尝试经 ffmpeg 转 wav（若系统有）
        raise HTTPException(
            status_code=400,
            detail="无法解码音频。请上传 wav/flac/ogg；或先转为 16k PCM wav。",
        ) from None

    if getattr(samples, "ndim", 1) > 1:
        samples = samples.mean(axis=1)
    samples = np.asarray(samples, dtype=np.float32)
    return samples, int(sr)


def _resample_if_needed(samples: np.ndarray, sr: int, target_sr: int) -> np.ndarray:
    if sr == target_sr:
        return samples
    if sr <= 0:
        raise HTTPException(status_code=400, detail="无效采样率")
    # 线性重采样，避免强依赖 librosa
    duration = samples.shape[0] / float(sr)
    n = max(1, int(round(duration * target_sr)))
    x_old = np.linspace(0.0, 1.0, num=samples.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


def transcribe_bytes(data: bytes) -> dict[str, Any]:
    recognizer = get_recognizer()
    samples, sr = _load_audio_bytes(data)
    target_sr = int(_model_meta.get("sample_rate") or 16000)
    samples = _resample_if_needed(samples, sr, target_sr)

    t0 = time.time()
    stream = recognizer.create_stream()
    stream.accept_waveform(target_sr, samples)
    recognizer.decode_stream(stream)
    result = stream.result
    elapsed = time.time() - t0

    text = getattr(result, "text", None) or ""
    lang = getattr(result, "lang", None) or ""
    emotion = getattr(result, "emotion", None) or ""
    event = getattr(result, "event", None) or ""
    timestamps = list(getattr(result, "timestamps", None) or [])

    return {
        "success": True,
        "text": text.strip(),
        "lang": lang,
        "emotion": emotion,
        "event": event,
        "timestamps": timestamps,
        "duration_sec": round(float(samples.shape[0]) / float(target_sr), 3),
        "elapsed_sec": round(elapsed, 3),
        "model": _model_meta.get("dir"),
        "engine": "sherpa-onnx",
    }


class Base64Body(BaseModel):
    audio: str = Field(..., description="data URL 或纯 base64")
    filename: Optional[str] = None


def _decode_base64_audio(raw: str) -> bytes:
    s = (raw or "").strip()
    if "," in s and s.lower().startswith("data:"):
        s = s.split(",", 1)[1]
    try:
        return base64.b64decode(s, validate=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail="base64 解码失败: " + str(e)) from e


@app.get("/health")
def health():
    ready = False
    err = None
    try:
        get_recognizer()
        ready = True
    except Exception as e:
        err = str(e)
    return {
        "ok": True,
        "service": "hzdv-asr",
        "engine": "sherpa-onnx",
        "model_ready": ready,
        "model": _model_meta.get("dir") if ready else None,
        "models_dir": str(MODELS_DIR),
        "error": err,
    }


@app.post("/asr")
async def asr_upload(
    file: UploadFile = File(...),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    return transcribe_bytes(data)


@app.post("/asr/base64")
async def asr_base64(
    body: Base64Body,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    data = _decode_base64_audio(body.audio)
    if not data:
        raise HTTPException(status_code=400, detail="空音频")
    return transcribe_bytes(data)
