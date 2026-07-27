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


def _table_to_text(rows: list[list[Any]]) -> str:
    """把表格行列格式化成可读文本（保留表头）。"""
    if not rows:
        return ""
    cleaned: list[list[str]] = []
    for row in rows:
        cells = [("" if c is None else str(c).replace("\n", " ").strip()) for c in (row or [])]
        if any(cells):
            cleaned.append(cells)
    if not cleaned:
        return ""
    ncols = max(len(r) for r in cleaned)
    for r in cleaned:
        while len(r) < ncols:
            r.append("")
    # 用制表符对齐，LLM/预览都好读
    return "\n".join("\t".join(r) for r in cleaned)


def _point_in_bbox(x: float, y: float, bbox: tuple[float, float, float, float], pad: float = 1.0) -> bool:
    x0, y0, x1, y1 = bbox
    return (x0 - pad) <= x <= (x1 + pad) and (y0 - pad) <= y <= (y1 + pad)


def _extract_page_visual_order(page: Any) -> tuple[str, list[dict[str, Any]], int]:
    """按页面视觉位置（上→下）合并表格与正文，避免 pypdf 内容流乱序。"""
    segments: list[tuple[float, float, str, str, Any]] = []
    # (top, x0, kind, text, bbox)
    table_bboxes: list[tuple[float, float, float, float]] = []

    try:
        found = page.find_tables() or []
    except Exception:
        found = []

    for t in found:
        try:
            rows = t.extract()
            bbox = tuple(float(x) for x in t.bbox)
        except Exception:
            continue
        body = _table_to_text(rows or [])
        if not body:
            continue
        table_bboxes.append(bbox)  # type: ignore[arg-type]
        segments.append((bbox[1], bbox[0], "table", "[表格]\n" + body, bbox))

    try:
        words = page.extract_words(use_text_flow=False) or []
    except Exception:
        words = []

    # 落在表格框内的字丢掉，避免和表格提取重复
    outside: list[dict[str, Any]] = []
    for w in words:
        cx = (float(w["x0"]) + float(w["x1"])) / 2.0
        cy = (float(w["top"]) + float(w["bottom"])) / 2.0
        if any(_point_in_bbox(cx, cy, bb) for bb in table_bboxes):
            continue
        outside.append(w)

    # 按 y 聚类成行，再按 x 拼字
    buckets: dict[int, list[dict[str, Any]]] = {}
    for w in outside:
        key = int(round(float(w["top"]) / 2.5) * 2)  # ~2–3pt 容差
        buckets.setdefault(key, []).append(w)

    for key in sorted(buckets.keys()):
        ws = sorted(buckets[key], key=lambda x: float(x["x0"]))
        line = " ".join(str(w.get("text") or "") for w in ws).strip()
        if not line:
            continue
        top = float(ws[0]["top"])
        x0 = float(ws[0]["x0"])
        bbox = (
            float(ws[0]["x0"]),
            float(ws[0]["top"]),
            float(ws[-1]["x1"]),
            float(max(float(w["bottom"]) for w in ws)),
        )
        segments.append((top, x0, "text", line, bbox))

    segments.sort(key=lambda s: (s[0], s[1]))

    # 若表格/词都没拿到，回退 pdfplumber 的整页抽取
    if not segments:
        try:
            raw = (page.extract_text() or "").strip()
        except Exception:
            raw = ""
        page_lines = [
            {"text": ln.strip(), "score": 1.0, "box": None, "kind": "text"}
            for ln in raw.splitlines()
            if ln.strip()
        ]
        return raw, page_lines, 0

    parts: list[str] = []
    page_lines: list[dict[str, Any]] = []
    table_count = 0
    for _top, _x0, kind, text, bbox in segments:
        parts.append(text)
        table_count += 1 if kind == "table" else 0
        box = None
        if bbox:
            box = [
                [bbox[0], bbox[1]],
                [bbox[2], bbox[1]],
                [bbox[2], bbox[3]],
                [bbox[0], bbox[3]],
            ]
        # 表格按行拆开预览
        for ln in text.splitlines():
            s = ln.strip()
            if s:
                page_lines.append(
                    {"text": s, "score": 1.0, "box": box if kind == "table" else box, "kind": kind}
                )

    return "\n".join(parts).strip(), page_lines, table_count


def run_pdf_bytes(data: bytes) -> dict[str, Any]:
    """提取 PDF 文本：按视觉阅读顺序（上→下），表格单独抽出后插回原位。

    优先 pdfplumber（带坐标）；失败再回退 pypdf。
    扫描件几乎无文字时标记 needs_vision。
    """
    if not data:
        raise HTTPException(status_code=400, detail="Empty PDF")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF too large (max 20MB)")

    pages_out: list[dict[str, Any]] = []
    lines: list[dict[str, Any]] = []
    texts: list[str] = []
    table_total = 0
    engine = "pdfplumber"

    try:
        import pdfplumber
    except ImportError:
        pdfplumber = None  # type: ignore
        engine = "pypdf"

    if pdfplumber is not None:
        try:
            with pdfplumber.open(io.BytesIO(data)) as pdf:
                for i, page in enumerate(pdf.pages):
                    page_text, page_lines, n_tables = _extract_page_visual_order(page)
                    table_total += n_tables
                    pages_out.append(
                        {
                            "page": i + 1,
                            "text": page_text,
                            "chars": len(page_text),
                            "tables": n_tables,
                        }
                    )
                    if page_text:
                        texts.append(f"--- page {i + 1} ---\n{page_text}")
                    for ln in page_lines:
                        lines.append({**ln, "page": i + 1})
                page_count = len(pdf.pages)
        except Exception as e:
            # pdfplumber 失败则回退
            engine = "pypdf"
            pages_out, lines, texts, page_count, table_total = [], [], [], 0, 0
            _pdfplumber_err = str(e)
        else:
            _pdfplumber_err = ""
    else:
        _pdfplumber_err = "pdfplumber not installed"

    if engine == "pypdf" or not pages_out:
        try:
            from pypdf import PdfReader
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail=f"PDF extractor unavailable ({_pdfplumber_err}); pypdf missing: {e}",
            ) from e
        try:
            reader = PdfReader(io.BytesIO(data))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}") from e
        pages_out, lines, texts = [], [], []
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
                        lines.append(
                            {"text": s, "score": 1.0, "box": None, "page": i + 1, "kind": "text"}
                        )
        page_count = len(reader.pages)
        engine = "pypdf"
        table_total = 0

    full_text = "\n\n".join(texts).strip()
    body_chars = sum(len((p.get("text") or "").strip()) for p in pages_out)
    reasons: list[str] = []
    if body_chars < 20:
        reasons.append("sparse_text")
    if page_count >= 8:
        reasons.append("dense_text")
    if table_total >= 1:
        # 有表格：建议至少第二梯队（纯文本也能读，但结构敏感）
        reasons.append("table_like")
    is_complex = page_count >= 12 or (page_count >= 5 and body_chars > 8000) or table_total >= 3
    if is_complex:
        suggested_tier = 3
    elif body_chars < 20:
        suggested_tier = 2
    elif page_count >= 3 or body_chars > 1500 or table_total >= 1:
        suggested_tier = 2
    else:
        suggested_tier = 1
    needs_vision = body_chars < 20

    return {
        "success": True,
        "source": "pdf",
        "engine": engine,
        "text": full_text,
        "lines": lines[:300],
        "line_count": len(lines),
        "pages": pages_out,
        "page_count": page_count,
        "table_count": table_total,
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
                "table_count": table_total,
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