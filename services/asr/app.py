"""HZDV ASR 微服务：Python + sherpa-onnx（Next-gen Kaldi ONNX）。

默认离线模型：SenseVoice Small int8（中/英/日/韩/粤），见 download_models.sh。
可选真流式：Zipformer CTC（streaming.json），WebSocket /asr/ws。

接口：
  GET  /health
  POST /asr          multipart: file=<audio>     （离线 SenseVoice）
  POST /asr/base64   JSON audio base64
  WS   /asr/ws       真流式 PCM 分片 → 边说边出字
"""

from __future__ import annotations

import base64
import io
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("ASR_MODELS_DIR", str(APP_DIR / "models"))).resolve()
API_KEY = (os.environ.get("ASR_API_KEY") or "").strip()
CORS_ORIGINS = (os.environ.get("ASR_CORS_ORIGINS") or "*").strip()
NUM_THREADS = int(os.environ.get("ASR_NUM_THREADS") or "2")
USE_ITN = (os.environ.get("ASR_USE_ITN") or "1").strip() not in ("0", "false", "False")
LANGUAGE = (os.environ.get("ASR_LANGUAGE") or "auto").strip() or "auto"
# 浏览器直连 WebSocket 用的公网地址（由 CF 代理透出），例 ws://asr.hzdv.net:8091/asr/ws
PUBLIC_WS_URL = (os.environ.get("ASR_PUBLIC_WS_URL") or "").strip()

app = FastAPI(title="hzdv-asr", version="0.2.0")
_origins = ["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_offline_recognizer = None
_offline_meta: dict[str, Any] = {}
_online_recognizer = None
_online_meta: dict[str, Any] = {}


def _check_api_key(x_api_key: Optional[str]) -> None:
    if not API_KEY:
        return
    if not x_api_key or x_api_key.strip() != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


def _load_offline_meta() -> dict[str, Any]:
    active_json = MODELS_DIR / "active.json"
    if active_json.is_file():
        return json.loads(active_json.read_text(encoding="utf-8"))
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
        f"未找到离线 ASR 模型。请先在 {MODELS_DIR} 运行 ./download_models.sh"
    )


def _load_streaming_meta() -> Optional[dict[str, Any]]:
    stream_json = MODELS_DIR / "streaming.json"
    if not stream_json.is_file():
        return None
    return json.loads(stream_json.read_text(encoding="utf-8"))


def get_offline_recognizer():
    global _offline_recognizer, _offline_meta
    if _offline_recognizer is not None:
        return _offline_recognizer

    import sherpa_onnx

    meta = _load_offline_meta()
    _offline_meta = meta
    kind = str(meta.get("kind") or "sense_voice")
    model_dir = MODELS_DIR / str(meta["dir"])

    if kind == "whisper":
        encoder = str(model_dir / meta["encoder"])
        decoder = str(model_dir / meta["decoder"])
        tokens = str(model_dir / meta["tokens"])
        _offline_recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=encoder,
            decoder=decoder,
            tokens=tokens,
            num_threads=NUM_THREADS,
            debug=False,
        )
    else:
        model = str(model_dir / meta["model"])
        tokens = str(model_dir / meta["tokens"])
        _offline_recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model,
            tokens=tokens,
            num_threads=NUM_THREADS,
            language=LANGUAGE,
            use_itn=USE_ITN,
            debug=False,
        )
    return _offline_recognizer


def get_online_recognizer():
    """可选：真正的 OnlineRecognizer（Zipformer 等）。SenseVoice 模拟流式不走这里。"""
    global _online_recognizer, _online_meta
    if _online_recognizer is not None:
        return _online_recognizer

    meta = _load_streaming_meta()
    if not meta:
        return None
    kind = str(meta.get("kind") or "")
    if kind in ("sense_voice_simulate", "sensevoice", "sense_voice"):
        # 模拟流式用离线 SenseVoice + VAD，不加载 OnlineRecognizer
        _online_meta = meta
        return None

    import sherpa_onnx

    _online_meta = meta
    model_dir = MODELS_DIR / str(meta["dir"])
    tokens = str(model_dir / meta["tokens"])

    if kind in ("zipformer2_ctc", "ctc"):
        model = str(model_dir / meta["model"])
        _online_recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
            tokens=tokens,
            model=model,
            num_threads=NUM_THREADS,
            sample_rate=int(meta.get("sample_rate") or 16000),
            feature_dim=80,
            decoding_method="greedy_search",
            provider="cpu",
        )
    elif kind in ("transducer", "zipformer"):
        _online_recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens,
            encoder=str(model_dir / meta["encoder"]),
            decoder=str(model_dir / meta["decoder"]),
            joiner=str(model_dir / meta["joiner"]),
            num_threads=NUM_THREADS,
            sample_rate=int(meta.get("sample_rate") or 16000),
            feature_dim=80,
            decoding_method="greedy_search",
            provider="cpu",
        )
    else:
        raise ValueError(f"未知流式模型 kind: {kind}")
    return _online_recognizer


def streaming_kind() -> str:
    meta = _load_streaming_meta() or {}
    if meta:
        return str(meta.get("kind") or "sense_voice_simulate")
    # 无 streaming.json 时：有 SenseVoice + silero 即可做模拟流式
    if (MODELS_DIR / "silero_vad.onnx").is_file():
        try:
            get_offline_recognizer()
            return "sense_voice_simulate"
        except Exception:
            pass
    return ""


def ensure_streaming_ready() -> dict[str, Any]:
    """返回流式后端信息；未就绪则抛 HTTPException。"""
    kind = streaming_kind()
    if kind in ("sense_voice_simulate", "sensevoice", "sense_voice"):
        get_offline_recognizer()
        vad_path = MODELS_DIR / "silero_vad.onnx"
        if not vad_path.is_file():
            raise HTTPException(
                status_code=503,
                detail="缺少 silero_vad.onnx。请运行: ./download_models.sh vad && ./download_models.sh streaming",
            )
        meta = _load_streaming_meta() or {
            "kind": "sense_voice_simulate",
            "dir": _offline_meta.get("dir"),
            "vad": "silero_vad.onnx",
            "sample_rate": 16000,
        }
        global _online_meta
        _online_meta = meta
        return {"kind": "sense_voice_simulate", "meta": meta, "sample_rate": 16000}
    if kind in ("transducer", "zipformer", "zipformer2_ctc", "ctc"):
        rec = get_online_recognizer()
        if rec is None:
            raise HTTPException(status_code=503, detail="OnlineRecognizer 未就绪")
        return {
            "kind": kind,
            "meta": _online_meta,
            "sample_rate": int(_online_meta.get("sample_rate") or 16000),
            "recognizer": rec,
        }
    raise HTTPException(
        status_code=503,
        detail="流式未配置。请运行: ./download_models.sh streaming（SenseVoice 模拟流式）",
    )


def _create_silero_vad():
    import sherpa_onnx

    vad_path = MODELS_DIR / "silero_vad.onnx"
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(vad_path)
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.25
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 8
    config.sample_rate = 16000
    window_size = int(config.silero_vad.window_size)
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=100)
    return vad, window_size


def _sensevoice_decode_samples(samples: np.ndarray, sample_rate: int = 16000) -> str:
    if samples is None or samples.size < int(0.15 * sample_rate):
        return ""
    recognizer = get_offline_recognizer()
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, np.asarray(samples, dtype=np.float32))
    recognizer.decode_stream(stream)
    result = stream.result
    return (getattr(result, "text", None) or "").strip()


def _new_sensevoice_session() -> dict[str, Any]:
    vad, window_size = _create_silero_vad()
    return {
        "backend": "sense_voice_simulate",
        "vad": vad,
        "window_size": window_size,
        "buffer": np.zeros(0, dtype=np.float32),
        "offset": 0,
        "started": False,
        "last_partial_at": 0.0,
        "last_text": "",
        "committed": [],
        "ts": time.time(),
        "sample_rate": 16000,
    }


def _feed_sensevoice_session(sess: dict[str, Any], samples: np.ndarray) -> dict[str, Any]:
    """喂入 16k float32；返回 partial / final / committed。"""
    sr = int(sess["sample_rate"])
    vad = sess["vad"]
    window_size = int(sess["window_size"])
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if samples.size:
        sess["buffer"] = np.concatenate([sess["buffer"], samples])

    buf = sess["buffer"]
    offset = int(sess["offset"])
    while offset + window_size <= len(buf):
        vad.accept_waveform(buf[offset : offset + window_size])
        if not sess["started"] and vad.is_speech_detected():
            sess["started"] = True
            sess["last_partial_at"] = time.time()
        offset += window_size
    sess["offset"] = offset

    # 未开始说话时裁剪过长静音缓冲
    if not sess["started"]:
        if len(buf) > 10 * window_size:
            keep = 10 * window_size
            drop = len(buf) - keep
            sess["buffer"] = buf[-keep:]
            sess["offset"] = max(0, offset - drop)
            buf = sess["buffer"]

    partial = sess.get("last_text") or ""
    final_text = None

    # 说话中定期用整段 buffer 跑 SenseVoice → 模拟边说边上屏
    if sess["started"] and time.time() - float(sess["last_partial_at"]) >= 0.25:
        text = _sensevoice_decode_samples(sess["buffer"], sr)
        if text:
            partial = text
            sess["last_text"] = text
        sess["last_partial_at"] = time.time()

    # VAD 吐出完整句 → 定稿
    while not vad.empty():
        seg = vad.front.samples
        vad.pop()
        text = _sensevoice_decode_samples(np.asarray(seg, dtype=np.float32), sr)
        if text:
            sess["committed"].append(text)
            final_text = text
        sess["buffer"] = np.zeros(0, dtype=np.float32)
        sess["offset"] = 0
        sess["started"] = False
        sess["last_text"] = ""
        partial = ""
        sess["last_partial_at"] = 0.0

    return {
        "partial": partial,
        "final": final_text,
        "committed": list(sess["committed"]),
    }


def _end_sensevoice_session(sess: dict[str, Any]) -> dict[str, Any]:
    sr = int(sess["sample_rate"])
    # 冲掉 VAD 里残留
    vad = sess["vad"]
    try:
        # 一些版本有 flush；没有就靠 buffer 尾部识别
        if hasattr(vad, "flush"):
            vad.flush()
    except Exception:
        pass
    while not vad.empty():
        seg = vad.front.samples
        vad.pop()
        text = _sensevoice_decode_samples(np.asarray(seg, dtype=np.float32), sr)
        if text:
            sess["committed"].append(text)

    if sess.get("started") and sess["buffer"] is not None and len(sess["buffer"]) > 0:
        text = _sensevoice_decode_samples(sess["buffer"], sr)
        if text:
            # 避免与最后一句完全重复
            if not sess["committed"] or sess["committed"][-1] != text:
                sess["committed"].append(text)

    committed = list(sess["committed"])
    return {
        "final": committed[-1] if committed else None,
        "committed": committed,
        "text": " ".join(committed).strip(),
        "partial": "",
    }


# 兼容旧调用名
def get_recognizer():
    return get_offline_recognizer()


def _load_audio_bytes(data: bytes) -> tuple[np.ndarray, int]:
    """返回 float32 mono samples + sample_rate。"""
    import soundfile as sf

    try:
        samples, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    except Exception:
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
    duration = samples.shape[0] / float(sr)
    n = max(1, int(round(duration * target_sr)))
    x_old = np.linspace(0.0, 1.0, num=samples.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


def transcribe_bytes(data: bytes) -> dict[str, Any]:
    recognizer = get_offline_recognizer()
    samples, sr = _load_audio_bytes(data)
    target_sr = int(_offline_meta.get("sample_rate") or 16000)
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
        "model": _offline_meta.get("dir"),
        "engine": "sherpa-onnx",
        "mode": "offline",
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
    offline_ready = False
    offline_err = None
    streaming_ready = False
    streaming_err = None
    streaming_model = None
    streaming_mode = None
    try:
        get_offline_recognizer()
        offline_ready = True
    except Exception as e:
        offline_err = str(e)
    try:
        info = ensure_streaming_ready()
        streaming_ready = True
        streaming_mode = info.get("kind")
        meta = info.get("meta") or {}
        streaming_model = meta.get("dir") or streaming_mode
    except Exception as e:
        streaming_err = str(getattr(e, "detail", None) or e)
    return {
        "ok": True,
        "service": "hzdv-asr",
        "engine": "sherpa-onnx",
        "model_ready": offline_ready,
        "model": _offline_meta.get("dir") if offline_ready else None,
        "streaming_ready": streaming_ready,
        "streaming_mode": streaming_mode,
        "streaming_model": streaming_model,
        "ws_path": "/asr/ws",
        "ws_url": PUBLIC_WS_URL or None,
        "models_dir": str(MODELS_DIR),
        "error": offline_err,
        "streaming_error": streaming_err,
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


def _ws_authorized(websocket: WebSocket) -> bool:
    if not API_KEY:
        return True
    key = (
        websocket.query_params.get("key")
        or websocket.query_params.get("api_key")
        or websocket.headers.get("x-api-key")
        or ""
    )
    return key.strip() == API_KEY


@app.websocket("/asr/ws")
async def asr_ws(websocket: WebSocket):
    """真流式识别（浏览器可直连；若设了 API_KEY 需 ?key=）。

    客户端消息（JSON）：
      { "type": "start", "sampleRate": 16000 }
      { "type": "audio", "pcm": "<base64 float32 LE mono>", "sampleRate": 16000 }
      { "type": "end" }

    服务端消息：
      { "type": "ready", ... }
      { "type": "partial", "text": "..." }
      { "type": "final", "text": "..." }
      { "type": "error", "error": "..." }
    """
    if not _ws_authorized(websocket):
        await websocket.close(code=4401)
        return

    await websocket.accept()
    session_id = str(uuid.uuid4())

    try:
        recognizer = get_online_recognizer()
    except Exception as e:
        await websocket.send_json({"type": "error", "error": "加载流式模型失败: " + str(e)})
        await websocket.close()
        return

    if recognizer is None:
        await websocket.send_json(
            {
                "type": "error",
                "error": "真流式模型未就绪。请在 VPS 执行: cd services/asr && ./download_models.sh streaming",
            }
        )
        await websocket.close()
        return

    target_sr = int(_online_meta.get("sample_rate") or 16000)
    stream = recognizer.create_stream()
    last_text = ""

    await websocket.send_json(
        {
            "type": "ready",
            "sessionId": session_id,
            "model": _online_meta.get("dir"),
            "sampleRate": target_sr,
            "engine": "sherpa-onnx",
            "mode": "streaming",
        }
    )

    def decode_and_emit_sync() -> tuple[str, bool]:
        nonlocal last_text
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = (recognizer.get_result(stream) or "").strip()
        is_end = False
        try:
            is_end = bool(recognizer.is_endpoint(stream))
        except Exception:
            is_end = False
        return text, is_end

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            payload = None
            if msg.get("text") is not None:
                try:
                    payload = json.loads(msg["text"])
                except Exception:
                    await websocket.send_json({"type": "error", "error": "Invalid JSON"})
                    continue
            elif msg.get("bytes") is not None:
                raw = msg["bytes"]
                samples = np.frombuffer(raw, dtype=np.float32)
                if samples.size == 0:
                    continue
                stream.accept_waveform(target_sr, samples)
                text, is_end = decode_and_emit_sync()
                if text != last_text:
                    last_text = text
                    await websocket.send_json({"type": "partial", "text": text})
                if is_end and text:
                    await websocket.send_json({"type": "final", "text": text})
                    recognizer.reset(stream)
                    last_text = ""
                continue
            else:
                continue

            mtype = str((payload or {}).get("type") or "").lower()
            if mtype == "start":
                stream = recognizer.create_stream()
                last_text = ""
                await websocket.send_json(
                    {
                        "type": "started",
                        "sessionId": session_id,
                        "sampleRate": int(payload.get("sampleRate") or target_sr),
                    }
                )
                continue

            if mtype == "audio":
                b64 = payload.get("pcm") or payload.get("audio") or ""
                sr = int(payload.get("sampleRate") or target_sr)
                try:
                    raw = base64.b64decode(b64, validate=False)
                except Exception:
                    await websocket.send_json({"type": "error", "error": "pcm base64 无效"})
                    continue
                dtype = str(payload.get("dtype") or "float32").lower()
                if dtype in ("int16", "i16"):
                    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                else:
                    samples = np.frombuffer(raw, dtype=np.float32)
                if samples.size == 0:
                    continue
                if sr != target_sr:
                    samples = _resample_if_needed(samples, sr, target_sr)
                stream.accept_waveform(target_sr, samples)
                text, is_end = decode_and_emit_sync()
                if text != last_text:
                    last_text = text
                    await websocket.send_json({"type": "partial", "text": text})
                if is_end and text:
                    await websocket.send_json({"type": "final", "text": text})
                    recognizer.reset(stream)
                    last_text = ""
                continue

            if mtype == "end":
                pad = np.zeros(int(0.6 * target_sr), dtype=np.float32)
                stream.accept_waveform(target_sr, pad)
                stream.input_finished()
                text, _is_end = decode_and_emit_sync()
                if text:
                    await websocket.send_json({"type": "final", "text": text})
                await websocket.send_json({"type": "done", "sessionId": session_id})
                break

            if mtype == "ping":
                await websocket.send_json({"type": "pong"})
                continue

    except WebSocketDisconnect:
        return
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "error": str(e)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------- HTTP 真流式会话（经 CF /api/asr 代理，浏览器无需持有 API Key）----------
_stream_sessions: dict[str, dict[str, Any]] = {}
_STREAM_TTL_SEC = 300


def _purge_old_sessions() -> None:
    now = time.time()
    dead = [k for k, v in _stream_sessions.items() if now - v.get("ts", 0) > _STREAM_TTL_SEC]
    for k in dead:
        _stream_sessions.pop(k, None)


class StreamBody(BaseModel):
    action: str = Field(..., description="start | audio | end")
    sessionId: Optional[str] = None
    pcm: Optional[str] = None
    sampleRate: Optional[int] = 16000
    dtype: Optional[str] = "float32"


@app.post("/asr/stream")
async def asr_stream_http(
    body: StreamBody,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    """默认：SenseVoice Small 模拟流式（Silero VAD + 离线 SenseVoice）。
    若 streaming.json 配置为 Zipformer Online，则走真 OnlineRecognizer。
    """
    _check_api_key(x_api_key)
    _purge_old_sessions()
    action = str(body.action or "").lower().strip()
    info = ensure_streaming_ready()
    kind = info["kind"]
    target_sr = int(info["sample_rate"])
    meta = info.get("meta") or {}

    if action == "start":
        sid = str(uuid.uuid4())
        if kind == "sense_voice_simulate":
            sess = _new_sensevoice_session()
            sess["ts"] = time.time()
            _stream_sessions[sid] = sess
        else:
            recognizer = info["recognizer"]
            _stream_sessions[sid] = {
                "backend": "online",
                "recognizer": recognizer,
                "stream": recognizer.create_stream(),
                "last_text": "",
                "committed": [],
                "ts": time.time(),
                "sample_rate": target_sr,
            }
        return {
            "success": True,
            "sessionId": sid,
            "model": meta.get("dir") or kind,
            "sampleRate": target_sr,
            "mode": kind,
            "engine": "sherpa-onnx",
        }

    sid = str(body.sessionId or "").strip()
    sess = _stream_sessions.get(sid)
    if not sess:
        raise HTTPException(status_code=404, detail="无效或过期的 sessionId")
    sess["ts"] = time.time()

    if action == "audio":
        if not body.pcm:
            raise HTTPException(status_code=400, detail="缺少 pcm")
        try:
            raw = base64.b64decode(body.pcm, validate=False)
        except Exception as e:
            raise HTTPException(status_code=400, detail="pcm base64 无效") from e
        dtype = str(body.dtype or "float32").lower()
        if dtype in ("int16", "i16"):
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            samples = np.frombuffer(raw, dtype=np.float32)
        sr = int(body.sampleRate or target_sr)
        if samples.size == 0:
            return {
                "success": True,
                "sessionId": sid,
                "partial": sess.get("last_text") or "",
                "committed": list(sess.get("committed") or []),
            }
        if sr != target_sr:
            samples = _resample_if_needed(samples, sr, target_sr)

        if sess.get("backend") == "sense_voice_simulate":
            out = _feed_sensevoice_session(sess, samples)
            return {
                "success": True,
                "sessionId": sid,
                "partial": out.get("partial") or "",
                "final": out.get("final"),
                "committed": out.get("committed") or [],
                "mode": "sense_voice_simulate",
            }

        recognizer = sess["recognizer"]
        stream = sess["stream"]
        stream.accept_waveform(target_sr, samples)
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = (recognizer.get_result(stream) or "").strip()
        sess["last_text"] = text
        final_text = None
        try:
            is_end = bool(recognizer.is_endpoint(stream))
        except Exception:
            is_end = False
        if is_end and text:
            sess["committed"].append(text)
            final_text = text
            recognizer.reset(stream)
            sess["last_text"] = ""
            text = ""
        return {
            "success": True,
            "sessionId": sid,
            "partial": text,
            "final": final_text,
            "committed": list(sess["committed"]),
            "mode": "online",
        }

    if action == "end":
        if sess.get("backend") == "sense_voice_simulate":
            out = _end_sensevoice_session(sess)
            _stream_sessions.pop(sid, None)
            return {
                "success": True,
                "sessionId": sid,
                "final": out.get("final"),
                "committed": out.get("committed") or [],
                "text": out.get("text") or "",
                "done": True,
                "mode": "sense_voice_simulate",
            }

        recognizer = sess["recognizer"]
        stream = sess["stream"]
        pad = np.zeros(int(0.6 * target_sr), dtype=np.float32)
        stream.accept_waveform(target_sr, pad)
        try:
            stream.input_finished()
        except Exception:
            pass
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = (recognizer.get_result(stream) or "").strip()
        if text:
            sess["committed"].append(text)
        committed = list(sess["committed"])
        _stream_sessions.pop(sid, None)
        return {
            "success": True,
            "sessionId": sid,
            "final": text or None,
            "committed": committed,
            "text": " ".join([t for t in committed if t]).strip(),
            "done": True,
            "mode": "online",
        }

    raise HTTPException(status_code=400, detail="action 须为 start | audio | end")
