"""HZDV OCR 微服务：Python + RapidOCR + ONNX Runtime。"""

from __future__ import annotations

import base64
import io
import os
from typing import Any

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="hzdv-ocr", version="0.1.0")

# 开发期可放开；生产建议只允许网关域名，或关掉 CORS（仅内网/同源代理访问）
_cors = os.getenv("OCR_CORS_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors.split(",") if o.strip()] or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_engine = None
_API_KEY = (os.getenv("OCR_API_KEY") or "").strip()


def get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR()
    return _engine


def assert_api_key(x_api_key: str | None) -> None:
    if not _API_KEY:
        return
    if (x_api_key or "").strip() != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def run_ocr_bytes(data: bytes) -> dict[str, Any]:
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 12MB)")

    engine = get_engine()
    # RapidOCR 接受 ndarray / 路径；用 PIL→numpy 更稳
    try:
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(data)).convert("RGB")
        arr = np.asarray(img)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}") from e

    result, elapse = engine(arr)
    lines: list[dict[str, Any]] = []
    texts: list[str] = []
    if result:
        for item in result:
            # item: [box, text, score]
            box, text, score = item[0], item[1], item[2]
            texts.append(str(text))
            lines.append(
                {
                    "text": str(text),
                    "score": float(score) if score is not None else None,
                    "box": box,
                }
            )

    full_text = "\n".join(texts).strip()
    return {
        "success": True,
        "text": full_text,
        "lines": lines,
        "line_count": len(lines),
        "elapse": elapse,
    }


class Base64Body(BaseModel):
    image: str = Field(..., description="data URL 或纯 base64")
    filename: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {"success": True, "service": "hzdv-ocr", "ready": True}


@app.post("/ocr")
async def ocr_upload(
    file: UploadFile = File(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    assert_api_key(x_api_key)
    data = await file.read()
    out = run_ocr_bytes(data)
    out["filename"] = file.filename or ""
    out["content_type"] = file.content_type or ""
    return out


@app.post("/ocr/base64")
async def ocr_base64(
    body: Base64Body,
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    assert_api_key(x_api_key)
    raw = body.image.strip()
    if "," in raw and raw.lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64: {e}") from e
    out = run_ocr_bytes(data)
    out["filename"] = body.filename or ""
    return out
