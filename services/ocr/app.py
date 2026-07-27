"""HZDV OCR 微服务：Python + RapidOCR + ONNX Runtime。

除识别文字外，还基于 box 坐标做「排版硬校验」（analyze_layout）：
纯几何规则判断是否复杂排版（多栏 / 表格 / 倾斜 / 低置信 / 字号混杂 / 超密），
给出 suggested_tier 作为下游意图分类的下限，避免小模型误判简单。
"""

from __future__ import annotations

import base64
import io
import math
import os
import statistics
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


def _box_bounds(box: Any) -> tuple[float, float, float, float]:
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    return min(xs), max(xs), min(ys), max(ys)


def _box_angle(box: Any) -> float:
    """文本框上边缘与水平线的夹角（度），用于判断拍歪/旋转。"""
    x0, y0 = float(box[0][0]), float(box[0][1])
    x1, y1 = float(box[1][0]), float(box[1][1])
    return math.degrees(math.atan2(y1 - y0, x1 - x0))


def _column_count(spans: list[tuple[float, float]], width: float, bins: int = 200) -> int:
    """把所有文本框投影到 x 轴，数中间有几条足够宽的空白沟（栏间距）。"""
    if not spans or width <= 0:
        return 1
    occupied = [False] * bins
    for x0, x1 in spans:
        b0 = max(0, min(bins - 1, int(x0 / width * bins)))
        b1 = max(0, min(bins - 1, int(math.ceil(x1 / width * bins)) - 1))
        for b in range(b0, max(b0, b1) + 1):
            occupied[b] = True
    filled = [i for i, v in enumerate(occupied) if v]
    if not filled:
        return 1
    first, last = filled[0], filled[-1]
    gap_min = max(3, int(0.06 * bins))
    columns, run = 1, 0
    for i in range(first, last + 1):
        if occupied[i]:
            if run >= gap_min:
                columns += 1
            run = 0
        else:
            run += 1
    return columns


def _side_by_side_ratio(rects: list[dict[str, float]]) -> float:
    """同一水平带内左右并排的文本框占比，高则像表格/表单。"""
    n = len(rects)
    if n < 2:
        return 0.0
    involved: set[int] = set()
    for i in range(n):
        for j in range(i + 1, n):
            a, b = rects[i], rects[j]
            h = min(a["y1"] - a["y0"], b["y1"] - b["y0"])
            if h <= 0:
                continue
            overlap_y = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
            if overlap_y / h < 0.5:
                continue
            if min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]) <= 0:
                involved.add(i)
                involved.add(j)
    return round(len(involved) / n, 3)


def analyze_layout(
    lines: list[dict[str, Any]], width: int, height: int
) -> dict[str, Any]:
    """排版硬校验：只用几何 + 置信度，不调模型。

    returns: { complex, suggested_tier, needs_vision, reasons: [code], metrics: {...} }
    """
    img_area = float(width * height) or 1.0
    if not lines:
        return {
            "complex": False,
            "suggested_tier": 2,
            "needs_vision": True,
            "reasons": ["no_text"],
            "metrics": {"line_count": 0, "width": width, "height": height},
        }

    rects: list[dict[str, float]] = []
    spans: list[tuple[float, float]] = []
    heights: list[float] = []
    angles: list[float] = []
    scores: list[float] = []
    text_area = 0.0

    for ln in lines:
        box = ln.get("box")
        if not box:
            continue
        x0, x1, y0, y1 = _box_bounds(box)
        rects.append({"x0": x0, "x1": x1, "y0": y0, "y1": y1})
        spans.append((x0, x1))
        heights.append(max(0.0, y1 - y0))
        angles.append(abs(_box_angle(box)))
        text_area += max(0.0, x1 - x0) * max(0.0, y1 - y0)
        if ln.get("score") is not None:
            scores.append(float(ln["score"]))

    line_count = len(rects)
    if line_count == 0:
        return {
            "complex": False,
            "suggested_tier": 2,
            "needs_vision": True,
            "reasons": ["no_box"],
            "metrics": {"line_count": 0, "width": width, "height": height},
        }

    mean_h = statistics.fmean(heights) if heights else 0.0
    height_cv = (
        round(statistics.pstdev(heights) / mean_h, 3) if len(heights) > 1 and mean_h else 0.0
    )
    mean_score = round(statistics.fmean(scores), 3) if scores else None
    low_conf_ratio = (
        round(sum(1 for s in scores if s < 0.6) / len(scores), 3) if scores else 0.0
    )
    mean_skew = round(statistics.fmean(angles), 2) if angles else 0.0
    columns = _column_count(spans, float(width))
    sbs_ratio = _side_by_side_ratio(rects)
    coverage = round(text_area / img_area, 4)

    metrics = {
        "line_count": line_count,
        "width": width,
        "height": height,
        "columns": columns,
        "side_by_side_ratio": sbs_ratio,
        "mean_score": mean_score,
        "low_conf_ratio": low_conf_ratio,
        "mean_skew_deg": mean_skew,
        "height_cv": height_cv,
        "text_coverage": coverage,
    }

    # 硬触发：命中任一即判复杂排版（结构性问题，纯文本喂给 LLM 会丢语义）
    hard: list[str] = []
    if columns >= 2:
        hard.append("multi_column")
    if sbs_ratio >= 0.3:
        hard.append("table_like")
    if low_conf_ratio >= 0.25:
        hard.append("low_confidence")
    if mean_skew >= 12:
        hard.append("severe_skew")

    # 软信号：单个只抬到第二梯队，两个以上才算复杂。
    # 轻微倾斜放这里：识别质量往往仍然可用，没必要直接上军师模型。
    soft: list[str] = []
    if height_cv >= 0.5:
        soft.append("mixed_font_size")
    if 5 <= mean_skew < 12:
        soft.append("skewed")
    if line_count >= 40:
        soft.append("dense_text")
    if coverage < 0.02 and line_count <= 3:
        soft.append("sparse_text")

    is_complex = bool(hard) or len(soft) >= 2
    if is_complex:
        suggested_tier = 3
    elif line_count >= 8 or soft:
        suggested_tier = 2
    else:
        suggested_tier = 1

    needs_vision = low_conf_ratio >= 0.35 or (line_count <= 1 and coverage < 0.02)

    return {
        "complex": is_complex,
        "suggested_tier": suggested_tier,
        "needs_vision": bool(needs_vision),
        "reasons": hard + soft,
        "metrics": metrics,
    }


def is_pdf_bytes(data: bytes, filename: str | None = None, content_type: str | None = None) -> bool:
    if data[:5] == b"%PDF-":
        return True
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        return True
    ct = (content_type or "").lower()
    return "application/pdf" in ct


def run_pdf_bytes(data: bytes) -> dict[str, Any]:
    """提取 PDF 文本（pypdf）。扫描件几乎无文字时标记 needs_vision，后续可走识图梯队。"""
    if not data:
        raise HTTPException(status_code=400, detail="Empty PDF")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF too large (max 20MB)")

    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"pypdf not installed: {e}") from e

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}") from e

    pages_out: list[dict[str, Any]] = []
    lines: list[dict[str, Any]] = []
    texts: list[str] = []
    for i, page in enumerate(reader.pages):
        try:
            raw = page.extract_text() or ""
        except Exception:
            raw = ""
        page_text = raw.strip()
        pages_out.append({"page": i + 1, "text": page_text, "chars": len(page_text)})
        if page_text:
            texts.append(f"--- page {i + 1} ---\n{page_text}")
            for ln in page_text.splitlines():
                s = ln.strip()
                if s:
                    lines.append({"text": s, "score": 1.0, "box": None, "page": i + 1})

    full_text = "\n\n".join(texts).strip()
    page_count = len(reader.pages)
    # 不含页眉标记的纯正文长度，用来判断是不是扫描件
    body_chars = sum(len((p.get("text") or "").strip()) for p in pages_out)
    char_count = len(full_text)
    # 硬校验（PDF 版）：页数多 / 几乎无字 → 抬梯队或建议识图
    reasons: list[str] = []
    if body_chars < 20:
        reasons.append("sparse_text")
    if page_count >= 8:
        reasons.append("dense_text")
    is_complex = page_count >= 12 or (page_count >= 5 and body_chars > 8000)
    if is_complex:
        suggested_tier = 3
    elif body_chars < 20:
        suggested_tier = 2
    elif page_count >= 3 or body_chars > 1500:
        suggested_tier = 2
    else:
        suggested_tier = 1
    needs_vision = body_chars < 20  # 多半是扫描件

    return {
        "success": True,
        "source": "pdf",
        "text": full_text,
        "lines": lines[:200],
        "line_count": len(lines),
        "pages": pages_out,
        "page_count": page_count,
        "elapse": None,
        "image": None,
        "layout": {
            "complex": is_complex,
            "suggested_tier": suggested_tier,
            "needs_vision": needs_vision,
            "reasons": reasons,
            "metrics": {
                "page_count": page_count,
                "char_count": body_chars,
                "line_count": len(lines),
            },
        },
    }


def run_ocr_bytes(data: bytes) -> dict[str, Any]:
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 12MB)")

    # 误把 PDF 丢进 OCR 时自动改走文本提取
    if is_pdf_bytes(data):
        return run_pdf_bytes(data)

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
    img_h, img_w = int(arr.shape[0]), int(arr.shape[1])
    out = {
        "success": True,
        "source": "image",
        "text": full_text,
        "lines": lines,
        "line_count": len(lines),
        "elapse": elapse,
        "image": {"width": img_w, "height": img_h},
        "layout": analyze_layout(lines, img_w, img_h),
    }
    return out


class Base64Body(BaseModel):
    image: str = Field(..., description="data URL 或纯 base64")
    filename: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {"success": True, "service": "hzdv-ocr", "ready": True, "pdf": True}


@app.post("/ocr")
async def ocr_upload(
    file: UploadFile = File(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    assert_api_key(x_api_key)
    data = await file.read()
    filename = file.filename or ""
    content_type = file.content_type or ""
    if is_pdf_bytes(data, filename, content_type):
        out = run_pdf_bytes(data)
    else:
        out = run_ocr_bytes(data)
    out["filename"] = filename
    out["content_type"] = content_type
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
    if is_pdf_bytes(data, body.filename):
        out = run_pdf_bytes(data)
    else:
        out = run_ocr_bytes(data)
    out["filename"] = body.filename or ""
    return out