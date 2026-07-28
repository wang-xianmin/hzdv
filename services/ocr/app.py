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
import re
import statistics
import unicodedata
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


def _ocr_line_sort_key(ln: dict[str, Any]) -> tuple[float, float]:
    """阅读顺序：先上后下，同行偏左优先。"""
    box = ln.get("box")
    if not box:
        return (1e9, 1e9)
    x0, _x1, y0, y1 = _box_bounds(box)
    return ((y0 + y1) * 0.5, x0)


def image_lines_to_llm_text(lines: list[dict[str, Any]]) -> str:
    """简单图 → 给 LLM 的纯文本：按阅读顺序，不含置信度/坐标。

    1) 按 y 聚成视觉行（同行内按 x 拼接）
    2) 行与行之间换行
    """
    usable = [ln for ln in (lines or []) if str(ln.get("text") or "").strip()]
    if not usable:
        return ""

    items: list[dict[str, Any]] = []
    heights: list[float] = []
    for ln in usable:
        box = ln.get("box")
        text = str(ln.get("text") or "").strip()
        if not box:
            items.append({"text": text, "yc": 1e9, "x0": 1e9, "h": 20.0})
            continue
        x0, _x1, y0, y1 = _box_bounds(box)
        h = max(1.0, y1 - y0)
        heights.append(h)
        items.append({"text": text, "yc": (y0 + y1) * 0.5, "x0": x0, "h": h})

    med_h = statistics.median(heights) if heights else 20.0
    row_tol = med_h * 0.55
    items.sort(key=lambda it: (it["yc"], it["x0"]))

    rows: list[list[dict[str, Any]]] = []
    for it in items:
        if rows and abs(it["yc"] - rows[-1][0]["yc"]) <= row_tol:
            rows[-1].append(it)
        else:
            rows.append([it])

    out_lines: list[str] = []
    for row in rows:
        row.sort(key=lambda it: it["x0"])
        parts = [it["text"] for it in row]
        sample = "".join(parts)
        cjk = sum(1 for ch in sample if "\u4e00" <= ch <= "\u9fff")
        joiner = "" if cjk >= max(1, len(sample) // 4) else " "
        line = joiner.join(parts).strip()
        if line:
            out_lines.append(line)
    return "\n".join(out_lines).strip()


def is_pdf_bytes(data: bytes, filename: str | None = None, content_type: str | None = None) -> bool:
    if data[:5] == b"%PDF-":
        return True
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        return True
    ct = (content_type or "").lower()
    return "application/pdf" in ct


_CELL_KEY_LINE_RE = re.compile(r"^([A-Za-z_][\w]*)\s*:\s*(.*)$")
_CELL_CONST_LINE_RE = re.compile(r"^(?:[A-Z][A-Z0-9_]{2,}|window\.__[A-Za-z_]+)$")
_CELL_BITS_RE = re.compile(r"^[01]{4,}\b")
_CELL_SECTION_RE = re.compile(
    r"^[\w\u2e80-\ufaff、，,.\-（）()【】\[\]\s]+[:：]\s*$"
)
_CELL_ENUM_CONT_RE = re.compile(r"^\d+[=＝]")


def _pdf_text(text: Any) -> str:
    """PDF 常含兼容汉字（如 ⽤→用），先 NFKC 再匹配/拆行。"""
    return unicodedata.normalize("NFKC", "" if text is None else str(text))


def _split_raw_lines(text: str) -> list[str]:
    return [ln.strip() for ln in _pdf_text(text).split("\n") if ln.strip()]


def _is_cell_section_header(line: str) -> bool:
    s = _pdf_text(line).strip()
    if not s:
        return False
    if _CELL_SECTION_RE.match(s):
        return True
    if s.endswith(":") or s.endswith("："):
        return True
    m = _CELL_KEY_LINE_RE.match(s)
    return bool(m and not (m.group(2) or "").strip())


def _is_cell_structural_line(line: str) -> bool:
    """结构行：key:、常量、分组标题、短中文枚举项。"""
    s = _pdf_text(line).strip()
    if not s:
        return False
    if _CELL_CONST_LINE_RE.match(s):
        return True
    if _CELL_KEY_LINE_RE.match(s):
        return True
    if _is_cell_section_header(s):
        return True
    if _CELL_ENUM_CONT_RE.match(s):
        return True
    if re.match(r"^[\u2e80-\ufaffA-Za-z]", s) and len(s) <= 32:
        if "=" not in s and not re.search(r"[，,]{1}.*[，,=]", s):
            return True
    return False


def _is_tld_or_path_continuation(frag: str) -> bool:
    """邮箱/URL 因列宽折到下一行：.com / .ai / /chat/..."""
    s = _pdf_text(frag).strip()
    if not s:
        return False
    if re.match(r"^\.[A-Za-z]{2,24}\b", s):
        return True
    if s.startswith("/") and not s.startswith("//"):
        return True
    return False


def _is_url_or_email_context(text: str) -> bool:
    s = _pdf_text(text).strip()
    return bool("://" in s or "@" in s or s.startswith("http") or s.startswith("www."))


def _should_glue_url_or_email(prev: str, frag: str) -> bool:
    """仅拼接邮箱 / https?:// URL 的列宽软折（不管其它内容）。"""
    prev = _pdf_text(prev).strip()
    p = _pdf_text(frag).strip()
    if not prev or not p:
        return False
    # 新的完整 URL → 有意多行，不粘
    if p.startswith("http") and re.search(r"https?://\S", prev):
        return False
    if _CELL_KEY_LINE_RE.match(p) or _is_cell_section_header(p):
        return False
    if re.match(r"^[\u2e80-\ufaff]", p):
        return False
    if not _is_url_or_email_context(prev) and not p.startswith(("http", ".", "/", "@")):
        return False

    if _is_tld_or_path_continuation(p):
        return True
    if p.startswith("@") and re.search(r"[A-Za-z0-9._+-]$", prev):
        return True
    if prev.endswith(("://", "/", ".", "@", "=", "?", "&", "+", "%")) and re.match(
        r"^[A-Za-z0-9._~:@/?#\[\]!$&'()*+,;=%-]", p
    ):
        return True
    # 邮箱/URL 写到一半：...@g + mail.com ； ...co + m
    if _is_url_or_email_context(prev) and re.search(r"[A-Za-z0-9]$", prev) and re.match(
        r"^[A-Za-z0-9._~/-]+", p
    ):
        return True
    return False


def _should_glue_secret_key(prev: str, frag: str) -> bool:
    """API Key / Secret / 密码 / 模型名列：token 被列宽切断时无空格粘连。"""
    prev = _pdf_text(prev).strip()
    p = _pdf_text(frag).strip()
    if not prev or not p:
        return False
    if re.match(r"^[\u2e80-\ufaff]", p):
        return False
    if _CELL_KEY_LINE_RE.match(p) or _is_cell_section_header(p):
        return False
    # 密码/key/模型名常见字符（含 @!# 等）
    tok = r"A-Za-z0-9+/=_.@!#$%^&*()\[\]{}\-"
    if re.search(rf"[{tok}]$", prev) and re.match(rf"^[{tok}]+$", p):
        return True
    if prev.endswith(("-", "_", ".")) and re.match(r"^[A-Za-z0-9]", p):
        return True
    return False


def _column_glue_mode(header: str) -> str:
    """从表头判断列的软折策略：secret | auto。

    auto = 只拼邮箱/URL；
    secret = API/Secret Key、密码、模型名称/LLM 名称列，额外拼 token。
    """
    h = _pdf_text(header)
    hl = re.sub(r"\s+", "", h.lower())
    if any(
        k in hl
        for k in (
            "apikey",
            "api_key",
            "api-key",
            "secretkey",
            "secret_key",
            "secret-key",
            "sitekey",
            "site_key",
            "site-key",
            "accesskey",
            "privatekey",
            "hmac_secret",
            "hmacsecret",
            "encryption_key",
            "encryptionkey",
            "turnstile_site_key",
            "turnstile_secret_key",
            "turnstile",
            "password",
            "passwd",
            "pwd",
            "modelname",
            "model_name",
            "model-name",
            "llmname",
            "llm_name",
            "llm-name",
        )
    ):
        return "secret"
    if "api" in hl and "key" in hl:
        return "secret"
    if "secret" in hl and "key" in hl:
        return "secret"
    if "site" in hl and "key" in hl:
        return "secret"
    if "密钥" in h or "秘钥" in h or "令牌" in h or "密码" in h:
        return "secret"
    # 模型名称 / LLM 名称（避免单字「模型」误伤说明列）
    if any(k in h for k in ("模型名称", "模型名", "LLM名称", "LLM名", "大模型名称", "大模型名")):
        return "secret"
    if "llm" in hl and ("名称" in h or "name" in hl or "model" in hl):
        return "secret"
    if re.search(r"(^|[^a-z])model([^a-z]|$)", hl) and (
        "name" in hl or "名称" in h or hl in ("model", "models")
    ):
        return "secret"
    if h.strip() in (
        "密钥",
        "秘钥",
        "密码",
        "登录密码",
        "Key",
        "Secret",
        "Token",
        "Password",
        "模型",
        "模型名",
        "模型名称",
        "LLM",
        "LLM名称",
    ):
        return "secret"
    return "auto"


def _should_glue_pair(prev: str, frag: str, mode: str = "auto") -> bool:
    if _should_glue_url_or_email(prev, frag):
        return True
    if mode == "secret" and _should_glue_secret_key(prev, frag):
        return True
    return False


def _append_soft_fragment(prev: str, frag: str, mode: str = "auto") -> str:
    """邮箱/URL/Secret 软折粘连；有意多 URL 用分号；其它保留换行。"""
    p = _pdf_text(frag).strip()
    if not prev:
        return p
    if not p:
        return prev
    if _should_glue_pair(prev, p, mode):
        return prev + p
    if p.startswith("http") and re.search(r"https?://", prev):
        return prev + "；" + p
    return prev + "\n" + p


def _glue_typed_lines(lines: list[str], mode: str = "auto") -> list[str]:
    """按列类型粘合软折；保留 key: 与掩码、有意多行 URL。"""
    if not lines:
        return []
    out = [lines[0]]
    for p in lines[1:]:
        prev = out[-1]
        m = _CELL_KEY_LINE_RE.match(prev)
        if m and not (m.group(2) or "").strip() and _CELL_BITS_RE.match(p):
            out[-1] = prev.rstrip() + " " + p
            continue
        if (
            prev.rstrip().endswith(":")
            and _CELL_BITS_RE.match(p)
            and not prev.rstrip().endswith("://")
        ):
            out[-1] = prev + " " + p
            continue
        if _should_glue_pair(prev, p, mode):
            out[-1] = prev + p
            continue
        out.append(p)
    return out


def _glue_url_email_lines(lines: list[str]) -> list[str]:
    return _glue_typed_lines(lines, "auto")


def _merge_key_mask_lines(lines: list[str]) -> list[str]:
    """平行表路径：只粘 URL/邮箱软折与掩码。"""
    return _glue_typed_lines(lines, "auto")


def _split_parallel_cell_lines(text: str) -> list[str]:
    """平行多行表：保留结构换行，仅粘 URL/邮箱软折。"""
    return _merge_key_mask_lines(_split_raw_lines(text))


def _merge_soft_wrap_lines(text: str, mode: str = "auto") -> list[str]:
    """非平行表：只粘邮箱/URL（及 secret 列的 token）。"""
    return _glue_typed_lines(_split_raw_lines(text), mode)


def _join_multiline_cell(text: str, mode: str = "auto") -> str:
    """合并格内多行：仅邮箱/URL/Secret Key 软折粘连，其余保留换行。"""
    parts = _merge_soft_wrap_lines(text, mode)
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]

    out = parts[0]
    for p in parts[1:]:
        out = _append_soft_fragment(out, p, mode)
    out = re.sub(r"(\w)\s+\.(com|net|org|ai|dev|io|co|cn|app|me)\b", r"\1.\2", out, flags=re.I)
    out = re.sub(r"(https?://)\s+", r"\1", out, flags=re.I)
    out = re.sub(r"(https?://[^\s；\n]+)\s+([A-Za-z0-9._~/-]+)", r"\1\2", out)
    out = re.sub(r"(@[A-Za-z0-9.-]+)\s+\.(com|net|org|ai|dev|io|co|cn)\b", r"\1.\2", out, flags=re.I)
    out = re.sub(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)\s+([A-Za-z]{1,8})\b", r"\1\2", out)
    if mode == "secret":
        out = re.sub(r"(0x[0-9A-Fa-f]+)\s+([0-9A-Fa-f]+)", r"\1\2", out)
        out = re.sub(r"([A-Za-z0-9+/=_-]{8,})\s+([A-Za-z0-9+/=_-]{4,})", r"\1\2", out)
    return out


def _looks_deferred_cell_value(frag: str) -> bool:
    """上一行同列为空时，仅延后合并 URL。"""
    s = _pdf_text(frag).strip()
    if not s:
        return False
    if _CELL_KEY_LINE_RE.match(s) and not s.startswith("http"):
        return False
    return s.startswith("http")


def _looks_soft_continuation_frag(prev_cell: str, frag: str, mode: str = "auto") -> bool:
    """续行并进上一行同列：仅 URL/邮箱软折，或延后填入 URL。"""
    prev = _pdf_text(prev_cell).strip()
    s = _pdf_text(frag).strip()
    if not s:
        return True
    if not prev:
        return _looks_deferred_cell_value(s)
    if _should_glue_pair(prev, s, mode):
        return True
    if s.startswith("http") and re.search(r"https?://", prev):
        return True
    return False


def _is_continuation_data_row(
    prev: list[str], row: list[str], modes: list[str] | None = None
) -> bool:
    """首列为空，且非空格是上一行同列 URL/邮箱续写或延后 URL → 合并。"""
    if not prev or not row:
        return False
    if (row[0] or "").strip():
        return False
    nonempty = [(i, c) for i, c in enumerate(row) if (c or "").strip()]
    if not nonempty:
        return False
    for i, c in nonempty:
        prev_c = prev[i] if i < len(prev) else ""
        mode = modes[i] if modes and i < len(modes) else "auto"
        if not _looks_soft_continuation_frag(prev_c, c, mode):
            return False
    return True


def _merge_continuation_rows(
    matrix: list[list[str]], modes: list[str] | None = None
) -> list[list[str]]:
    if len(matrix) < 2:
        return matrix
    header, *data = matrix
    modes = modes or [_column_glue_mode(h) for h in header]
    out = [header[:]]
    for row in data:
        if out and len(out) > 1 and _is_continuation_data_row(out[-1], row, modes):
            prev = out[-1]
            merged = prev[:]
            while len(merged) < len(row):
                merged.append("")
            for i, c in enumerate(row):
                if not (c or "").strip():
                    continue
                mode = modes[i] if i < len(modes) else "auto"
                merged[i] = _append_soft_fragment(
                    merged[i] if i < len(merged) else "", c, mode
                )
            out[-1] = merged
        else:
            out.append(row[:])
    return out


def _cell_key_name(key: str) -> str:
    s = _pdf_text(key).strip()
    m = _CELL_KEY_LINE_RE.match(s)
    if m:
        return m.group(1).lower()
    m2 = re.match(r"^([A-Za-z_][\w]*)", s)
    return m2.group(1).lower() if m2 else s.lower()


def _const_matches_key(const: str, key: str) -> bool:
    """稀疏常量列：按名称语义挂到对应 key 行。"""
    c = _pdf_text(const).strip()
    kn = _cell_key_name(key)
    if not c or not kn:
        return False
    if c.startswith("USER_TYPE_"):
        suffix = c[len("USER_TYPE_") :].lower()
        if suffix == kn:
            return True
        if suffix.replace("_", "") == kn.replace("_", ""):
            return True
        return False
    cu = c.upper()
    if "CURRENTUSERGROUP" in cu.replace("_", ""):
        return kn == "group"
    if "CURRENTUSERROLE" in cu.replace("_", ""):
        return kn in ("g_role", "role", "grole")
    return False


def _looks_parallel_multiline(line_lists: list[list[str]]) -> bool:
    """至少两列多行，且左列像 key 列表（避免 URL 软折被当成平行表）。"""
    lengths = [len(x) for x in line_lists]
    if not lengths or max(lengths) < 2:
        return False
    if len(line_lists[0]) < 2:
        return False
    multi = sum(1 for n in lengths if n >= 2)
    if multi < 2:
        return False
    keyish = sum(
        1
        for ln in line_lists[0]
        if _CELL_KEY_LINE_RE.match(ln) or _is_cell_section_header(ln)
    )
    constish = 0
    for col in line_lists[1:]:
        constish += sum(1 for ln in col if _CELL_CONST_LINE_RE.match(ln))
    return keyish >= 2 or (keyish >= 1 and constish >= 2)


def _drop_empty_columns(matrix: list[list[str]]) -> list[list[str]]:
    """去掉整列皆空的列（pdfplumber 嵌套表常冒出空列）。"""
    if not matrix:
        return matrix
    ncols = max(len(r) for r in matrix)
    keep = [
        c
        for c in range(ncols)
        if any((r[c] if c < len(r) else "").strip() for r in matrix)
    ]
    if len(keep) == ncols:
        return matrix
    return [[(r[c] if c < len(r) else "") for c in keep] for r in matrix]


def _looks_key_value_row(cols: list[list[str]]) -> bool:
    """左列多个 key，右列说明行数更多 → 按键值对配对。"""
    if len(cols) < 2:
        return False
    keys, descs = cols[0], cols[1]
    if len(keys) < 2 or len(descs) <= len(keys):
        return False
    keyish = sum(1 for k in keys if _CELL_KEY_LINE_RE.match(k) or k.endswith(":"))
    return keyish >= max(2, len(keys) // 2)


def _is_desc_group_start(line: str) -> bool:
    s = _pdf_text(line).strip()
    if not s or _CELL_ENUM_CONT_RE.match(s):
        return False
    if _is_cell_section_header(s):
        return True
    if re.search(r"[:：]", s):
        return True
    if re.match(r"^[\u2e80-\ufaff()（）A-Za-z0-9、\-]{2,24}$", s):
        return True
    return False


def _group_description_lines(lines: list[str]) -> list[str]:
    """把说明列拆成与左列 key 一一对应的分组（含枚举续行 1= 2=）。"""
    groups: list[list[str]] = []
    cur: list[str] = []
    for ln in lines:
        s = _pdf_text(ln).strip()
        if not s:
            continue
        if _CELL_ENUM_CONT_RE.match(s) and cur:
            cur.append(s)
            continue
        if _is_desc_group_start(s) and cur:
            groups.append(cur)
            cur = [s]
        elif not cur:
            cur = [s]
        else:
            cur.append(s)
    if cur:
        groups.append(cur)
    return [_join_multiline_cell("\n".join(g)) for g in groups]


def _col_take(cols: list[list[str]], pointers: list[int], ci: int) -> str:
    if pointers[ci] >= len(cols[ci]):
        return ""
    v = cols[ci][pointers[ci]]
    pointers[ci] += 1
    return v


def _col_peek(cols: list[list[str]], pointers: list[int], ci: int) -> str | None:
    if pointers[ci] >= len(cols[ci]):
        return None
    return cols[ci][pointers[ci]]


def _expand_parallel_multiline_row(cells: list[str]) -> list[list[str]]:
    """以第 0 列为骨架拆平行子行；常量列按 key 语义对齐。"""
    cols = [_split_parallel_cell_lines(c) for c in cells]
    if not _looks_parallel_multiline(cols):
        return [[_join_multiline_cell(c) for c in cells]]

    ncols = len(cols)
    pointers = [0] * ncols
    primary = 0
    out_rows: list[list[str]] = []

    while pointers[primary] < len(cols[primary]):
        head = _col_take(cols, pointers, primary)
        row = [""] * ncols
        row[primary] = head

        if _is_cell_section_header(head):
            for ci in range(ncols):
                if ci == primary:
                    continue
                pk = _col_peek(cols, pointers, ci)
                if pk is not None and _is_cell_section_header(pk):
                    row[ci] = _col_take(cols, pointers, ci)
            out_rows.append(row)
            continue

        for ci in range(ncols):
            if ci == primary:
                continue
            pk = _col_peek(cols, pointers, ci)
            if pk is None:
                continue
            if _CELL_CONST_LINE_RE.match(pk):
                if _const_matches_key(pk, head):
                    row[ci] = _col_take(cols, pointers, ci)
                continue
            if _is_cell_section_header(pk):
                if _is_cell_section_header(head):
                    row[ci] = _col_take(cols, pointers, ci)
                continue
            row[ci] = _col_take(cols, pointers, ci)

        out_rows.append(row)

    while any(pointers[ci] < len(cols[ci]) for ci in range(ncols)):
        row = [""] * ncols
        for ci in range(ncols):
            if pointers[ci] < len(cols[ci]):
                row[ci] = _col_take(cols, pointers, ci)
        if any(row):
            out_rows.append(row)

    return out_rows if out_rows else [[_join_multiline_cell(c) for c in cells]]


def _expand_key_value_row(cells: list[str]) -> list[list[str]]:
    """左列多个 Metadata key、右列说明更长 → 按键值对展开。"""
    cols = [_split_parallel_cell_lines(c) for c in cells]
    if not _looks_key_value_row(cols):
        return [[_join_multiline_cell(c) for c in cells]]

    keys = cols[0]
    desc_groups = _group_description_lines(cols[1])
    ncols = len(cells)
    out: list[list[str]] = []
    for i, key in enumerate(keys):
        row = [key, desc_groups[i] if i < len(desc_groups) else ""]
        while len(row) < ncols:
            row.append("")
        out.append(row)
    return out


def _expand_data_row(cells: list[str], modes: list[str] | None = None) -> list[list[str]]:
    modes = modes or ["auto"] * len(cells)
    cols = [_split_parallel_cell_lines(c) for c in cells]
    extra_parallel = len(cols) > 2 and any(len(c) >= 2 for c in cols[2:])
    if _looks_key_value_row(cols) and not extra_parallel:
        return _expand_key_value_row(cells)
    if _looks_parallel_multiline(cols):
        return _expand_parallel_multiline_row(cells)
    return [
        [
            _join_multiline_cell(c, modes[i] if i < len(modes) else "auto")
            for i, c in enumerate(cells)
        ]
    ]


def _clean_table_matrix(rows: list[list[Any]] | None) -> list[list[str]]:
    """清洗行列：去空行、对齐列数；按表头决定 API/Secret Key 列软折。"""
    if not rows:
        return []
    prelim: list[list[str]] = []
    for row in rows:
        cells = [_pdf_text("" if c is None else str(c)) for c in (row or [])]
        if any(c.strip() for c in cells):
            prelim.append(cells)
    if not prelim:
        return []
    ncols = max(len(r) for r in prelim)
    for r in prelim:
        while len(r) < ncols:
            r.append("")

    header = [_join_multiline_cell(c, "auto") for c in prelim[0]]
    modes = [_column_glue_mode(h) for h in header]
    out: list[list[str]] = [header]
    for row in prelim[1:]:
        for expanded in _expand_data_row(row, modes):
            if any(str(x).strip() for x in expanded):
                out.append(expanded)
    return out


def _forward_fill_merged(matrix: list[list[str]]) -> list[list[str]]:
    """展开纵向合并：左侧连续空单元格继承上一行同列的值。

    例：第一列只有第一行写 Cloudflare KV，下面两行空白 → 自动填上。
    """
    if len(matrix) < 2:
        return matrix
    header, *data = matrix
    ncols = len(header)
    prev = [""] * ncols
    out = [header[:]]
    for row in data:
        new_row = row[:]
        while len(new_row) < ncols:
            new_row.append("")
        for c in range(ncols):
            if new_row[c]:
                break
            if prev[c]:
                new_row[c] = prev[c]
        for c in range(ncols):
            if new_row[c]:
                prev[c] = new_row[c]
        out.append(new_row)
    return out


def _normalize_table_matrix(rows: list[list[Any]] | None) -> list[list[str]]:
    cleaned = _clean_table_matrix(rows)
    modes = [_column_glue_mode(h) for h in cleaned[0]] if cleaned else []
    merged = _merge_continuation_rows(cleaned, modes)
    return _drop_empty_columns(_forward_fill_merged(merged))


def _table_to_display_text(matrix: list[list[str]]) -> str:
    """人读预览：制表符分列（已展开合并、已合并格内多行）。"""
    if not matrix:
        return ""
    return "\n".join("\t".join(r) for r in matrix)


def _table_to_flat_text(matrix: list[list[str]]) -> str:
    """供文本 LLM：Markdown 表 + 每行 key=value 备份（合并格已摊平）。"""
    if not matrix:
        return ""
    header = matrix[0]
    data = matrix[1:] if len(matrix) > 1 else []

    def esc(s: str) -> str:
        return str(s or "").replace("|", "\\|").replace("\n", "<br>")

    lines: list[str] = []
    lines.append("| " + " | ".join(esc(h) or " " for h in header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    for row in data:
        lines.append("| " + " | ".join(esc(c) for c in row) + " |")

    if data:
        lines.append("")
        lines.append("记录明细：")
        for i, row in enumerate(data, 1):
            pairs = []
            for h, c in zip(header, row):
                hv = (h or f"列{len(pairs)+1}").strip() or f"列{len(pairs)+1}"
                cv = (c or "").strip().replace("\n", "；")
                if cv:
                    pairs.append(hv + "=" + cv)
            if pairs:
                lines.append(str(i) + ". " + " | ".join(pairs))
    return "\n".join(lines)


def _format_table_block(rows: list[list[Any]] | None) -> tuple[str, str]:
    """返回 (预览完整块, 仅扁平供LLM)。"""
    matrix = _normalize_table_matrix(rows)
    if not matrix:
        return "", ""
    display = _table_to_display_text(matrix)
    flat = _table_to_flat_text(matrix)
    preview = (
        "[表格]\n"
        + display
        + "\n\n[表格·扁平·供LLM]\n"
        + flat
    )
    llm = "[表格]\n" + flat
    return preview, llm


def _table_to_text(rows: list[list[Any]]) -> str:
    """兼容旧调用：返回规范化后的预览表格块。"""
    preview, _ = _format_table_block(rows)
    return preview


_LIST_ROW_RE = re.compile(
    r"^("
    r"\d+[\.\)、]\s*"  # 1.  2)  3、
    r"|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]"
    r"|[○●•·◦▪️►▶︎]\s*"
    r"|第\d+[、.\)]\s*"
    r")"
)


def _is_real_table(rows: list[list[Any]] | None) -> bool:
    """过滤假表格：灰底列表、单列段落、大量空单元格等。

    真表格（如「图名称 / 原始尺寸 / …」）通常 ≥2 列、多行有实质内容。
    """
    if not rows or len(rows) < 2:
        return False

    cleaned: list[list[str]] = []
    for row in rows:
        cells = [("" if c is None else str(c).replace("\n", " ").strip()) for c in (row or [])]
        if any(cells):
            cleaned.append(cells)
    if len(cleaned) < 2:
        return False

    ncols = max(len(r) for r in cleaned)
    if ncols < 2:
        return False
    for r in cleaned:
        while len(r) < ncols:
            r.append("")

    # 至少两列在多数行里有内容
    strong_cols = 0
    for col in range(ncols):
        filled = sum(1 for r in cleaned if r[col])
        if filled >= max(2, (len(cleaned) + 1) // 2):
            strong_cols += 1
    if strong_cols < 2:
        return False

    total_cells = ncols * len(cleaned)
    empty_cells = sum(1 for r in cleaned for c in r if not c)
    if total_cells and empty_cells / total_cells > 0.65:
        return False

    # 多数行只有 1 个非空格，且像「1. xxx / ① xxx」→ 列表，不是表
    list_like = 0
    sparse = 0
    for r in cleaned:
        nonempty = [c for c in r if c]
        if len(nonempty) <= 1:
            sparse += 1
            t = nonempty[0] if nonempty else ""
            if _LIST_ROW_RE.match(t):
                list_like += 1
    if sparse >= len(cleaned) * 0.6 and list_like >= max(1, len(cleaned) // 3):
        return False
    if sparse >= len(cleaned) * 0.75:
        return False

    # 整表拼起来像编号列表（pdfplumber 有时把一段列表塞进 1～2 列）
    joined = " ".join(c for r in cleaned for c in r if c)
    if ncols <= 2 and len(_LIST_ROW_RE.findall(joined)) >= 2 and strong_cols < 3:
        # 有 ≥2 个列表标记，且没有稳定的第三列 → 当列表
        return False

    return True


def _find_page_tables(page: Any) -> list[Any]:
    """优先用线框策略找表；找不到再退回默认策略，但一律过 _is_real_table。"""
    candidates: list[Any] = []
    line_settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "intersection_tolerance": 8,
        "snap_tolerance": 4,
    }
    try:
        candidates = list(page.find_tables(table_settings=line_settings) or [])
    except Exception:
        candidates = []

    if not candidates:
        try:
            candidates = list(page.find_tables() or [])
        except Exception:
            candidates = []

    kept: list[Any] = []
    for t in candidates:
        try:
            rows = t.extract()
        except Exception:
            continue
        if _is_real_table(rows):
            kept.append(t)
    return kept


def _point_in_bbox(x: float, y: float, bbox: tuple[float, float, float, float], pad: float = 1.0) -> bool:
    x0, y0, x1, y1 = bbox
    return (x0 - pad) <= x <= (x1 + pad) and (y0 - pad) <= y <= (y1 + pad)


def _extract_page_visual_order(page: Any) -> tuple[str, str, list[dict[str, Any]], int]:
    """按页面视觉位置（上→下）合并表格与正文。

    正文用 pdfplumber 按垂直条带 crop 后 extract_text，避免中英混排
    因基线差被拆成两行、再按 y 排序把中文挤到英文后面。

    返回 (preview_text, llm_text, page_lines, table_count)。
    """
    page_width = float(page.width)
    page_height = float(page.height)

    found = _find_page_tables(page)
    table_items: list[tuple[float, float, float, float, str, str]] = []
    # (top, x0, bottom, x1, preview_body, llm_body)
    for t in found:
        try:
            rows = t.extract()
            bbox = tuple(float(x) for x in t.bbox)
            preview_body, llm_body = _format_table_block(rows or [])
        except Exception:
            continue
        if not preview_body:
            continue
        x0, top, x1, bottom = bbox
        table_items.append((top, x0, bottom, x1, preview_body, llm_body))
    table_items.sort(key=lambda it: (it[0], it[1]))

    def _crop_text(y0: float, y1: float) -> str:
        """抽取 [y0, y1) 垂直条带内的正文（不含表格）。"""
        if y1 - y0 < 2:
            return ""
        # 略微内缩，减少贴边裁切丢字
        top = max(0.0, y0)
        bottom = min(page_height, y1)
        if bottom - top < 2:
            return ""
        try:
            cropped = page.crop((0.0, top, page_width, bottom))
            # 过滤落在任一表格框内的字符，防止条带与表格垂直重叠时重复
            bboxes = [(it[1], it[0], it[3], it[2]) for it in table_items]  # x0,top,x1,bottom

            def keep(obj: dict[str, Any]) -> bool:
                if obj.get("object_type") != "char":
                    return True
                cx = (float(obj["x0"]) + float(obj["x1"])) / 2.0
                cy = (float(obj["top"]) + float(obj["bottom"])) / 2.0
                return not any(_point_in_bbox(cx, cy, bb, pad=2.0) for bb in bboxes)

            filtered = cropped.filter(keep)
            raw = filtered.extract_text(x_tolerance=3, y_tolerance=5) or ""
            return raw.strip()
        except Exception:
            try:
                return (page.crop((0.0, top, page_width, bottom)).extract_text() or "").strip()
            except Exception:
                return ""

    bands: list[tuple[float, str, str, str]] = []
    # (top, kind, preview_text, llm_text)
    cursor = 0.0
    for top, x0, bottom, x1, preview_body, llm_body in table_items:
        gap = _crop_text(cursor, top)
        if gap:
            bands.append((cursor, "text", gap, gap))
        bands.append((top, "table", preview_body, llm_body))
        cursor = max(cursor, bottom)
    tail = _crop_text(cursor, page_height)
    if tail:
        bands.append((cursor, "text", tail, tail))

    # 没有任何表格时：整页 extract_text（阅读顺序通常最好）
    if not table_items:
        try:
            raw = (page.extract_text(x_tolerance=3, y_tolerance=5) or "").strip()
        except Exception:
            raw = ""
        page_lines = [
            {"text": ln.strip(), "score": 1.0, "box": None, "kind": "text"}
            for ln in raw.splitlines()
            if ln.strip()
        ]
        return raw, raw, page_lines, 0

    if not bands:
        try:
            raw = (page.extract_text(x_tolerance=3, y_tolerance=5) or "").strip()
        except Exception:
            raw = ""
        page_lines = [
            {"text": ln.strip(), "score": 1.0, "box": None, "kind": "text"}
            for ln in raw.splitlines()
            if ln.strip()
        ]
        return raw, raw, page_lines, 0

    preview_parts: list[str] = []
    llm_parts: list[str] = []
    page_lines: list[dict[str, Any]] = []
    table_count = 0
    for _top, kind, preview_text, llm_text in bands:
        preview_parts.append(preview_text)
        llm_parts.append(llm_text)
        if kind == "table":
            table_count += 1
        for ln in preview_text.splitlines():
            s = ln.strip()
            if s:
                page_lines.append({"text": s, "score": 1.0, "box": None, "kind": kind})

    return (
        "\n".join(preview_parts).strip(),
        "\n".join(llm_parts).strip(),
        page_lines,
        table_count,
    )


def _score_pdf_page_complexity(
    plumber_page: Any | None,
    page_text: str,
    n_tables: int,
) -> dict[str, Any]:
    """逐页复杂度：扫描/嵌图/多表 → 标记并准备整页渲图；简单页只留文本。

    注意：suggested_tier 仅作提取侧提示。对话路由由「文档+用户问题」意图分类决定，
    仍可走第 2 梯队或无视觉的第 3 梯队。
    """
    reasons: list[str] = []
    chars = len((page_text or "").strip())
    needs_vision = False
    is_complex = False

    if chars < 40:
        reasons.append("sparse_text")
        needs_vision = True
        is_complex = True

    n_imgs = 0
    if plumber_page is not None:
        try:
            n_imgs = len(plumber_page.images or [])
        except Exception:
            n_imgs = 0
    if n_imgs >= 1:
        reasons.append("embedded_image")
        is_complex = True

    if n_tables >= 2:
        reasons.append("multi_table")
        is_complex = True
    elif n_tables >= 1 and chars > 2800:
        reasons.append("dense_table_page")
        is_complex = True

    # 提取侧提示：几乎无字才强烈建议视觉；复杂排版不强制对话梯队
    suggested_tier = 3 if needs_vision else 1
    return {
        "complex": is_complex,
        "needs_vision": needs_vision,
        "suggested_tier": suggested_tier,
        "reasons": reasons,
        "image_count": n_imgs,
    }


def _render_pdf_pages_jpeg(
    data: bytes,
    page_indices_0: list[int],
    *,
    dpi: int = 120,
    quality: int = 72,
    max_side: int = 1600,
) -> dict[int, dict[str, str]]:
    """用 PyMuPDF 把指定页渲成 JPEG base64。返回 {0-based index: {mime, base64}}。"""
    out: dict[int, dict[str, str]] = {}
    if not page_indices_0:
        return out
    try:
        import fitz  # PyMuPDF
        from PIL import Image
    except ImportError:
        return out

    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception:
        return out

    zoom = max(0.5, float(dpi) / 72.0)
    mat = fitz.Matrix(zoom, zoom)
    try:
        for idx in page_indices_0:
            if idx < 0 or idx >= doc.page_count:
                continue
            try:
                page = doc.load_page(idx)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                w, h = img.size
                scale = min(1.0, float(max_side) / float(max(w, h, 1)))
                if scale < 1.0:
                    img = img.resize(
                        (max(1, int(w * scale)), max(1, int(h * scale))),
                        Image.Resampling.LANCZOS,
                    )
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=quality, optimize=True)
                out[idx] = {
                    "mime": "image/jpeg",
                    "base64": base64.b64encode(buf.getvalue()).decode("ascii"),
                }
            except Exception:
                continue
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return out


def run_pdf_bytes(data: bytes) -> dict[str, Any]:
    """提取 PDF 文本：按视觉阅读顺序（上→下），表格单独抽出后插回原位。

    复杂页（嵌图/多表/几乎无字）整页渲图，供后续视觉模型选用；简单页只给文本。
    对话梯队不在此决定：由意图分类器结合用户问题再分（可走 tier2 / 无视觉 tier3）。
    """
    if not data:
        raise HTTPException(status_code=400, detail="Empty PDF")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF too large (max 20MB)")

    pages_out: list[dict[str, Any]] = []
    lines: list[dict[str, Any]] = []
    texts: list[str] = []
    texts_llm: list[str] = []
    table_total = 0
    engine = "pdfplumber"
    max_vision_pages = max(1, min(20, int(os.getenv("PDF_VISION_MAX_PAGES", "6") or "6")))
    render_dpi = max(72, min(200, int(os.getenv("PDF_RENDER_DPI", "120") or "120")))

    try:
        import pdfplumber
    except ImportError:
        pdfplumber = None  # type: ignore
        engine = "pypdf"

    if pdfplumber is not None:
        try:
            with pdfplumber.open(io.BytesIO(data)) as pdf:
                for i, page in enumerate(pdf.pages):
                    page_text, page_llm, page_lines, n_tables = _extract_page_visual_order(page)
                    table_total += n_tables
                    score = _score_pdf_page_complexity(page, page_text, n_tables)
                    pages_out.append(
                        {
                            "page": i + 1,
                            "text": page_text,
                            "text_llm": page_llm,
                            "chars": len(page_text),
                            "tables": n_tables,
                            "complex": score["complex"],
                            "needs_vision": score["needs_vision"],
                            "suggested_tier": score["suggested_tier"],
                            "reasons": score["reasons"],
                            "image_base64": None,
                            "image_mime": None,
                        }
                    )
                    if page_text:
                        texts.append(f"--- page {i + 1} ---\n{page_text}")
                    if page_llm:
                        texts_llm.append(f"--- page {i + 1} ---\n{page_llm}")
                    for ln in page_lines:
                        lines.append({**ln, "page": i + 1})
                page_count = len(pdf.pages)
        except Exception as e:
            # pdfplumber 失败则回退
            engine = "pypdf"
            pages_out, lines, texts, texts_llm, page_count, table_total = [], [], [], [], 0, 0
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
        pages_out, lines, texts, texts_llm = [], [], [], []
        for i, page in enumerate(reader.pages):
            try:
                raw = page.extract_text() or ""
            except Exception:
                raw = ""
            page_text = raw.strip()
            score = _score_pdf_page_complexity(None, page_text, 0)
            pages_out.append(
                {
                    "page": i + 1,
                    "text": page_text,
                    "text_llm": page_text,
                    "chars": len(page_text),
                    "tables": 0,
                    "complex": score["complex"],
                    "needs_vision": score["needs_vision"],
                    "suggested_tier": score["suggested_tier"],
                    "reasons": score["reasons"],
                    "image_base64": None,
                    "image_mime": None,
                }
            )
            if page_text:
                texts.append(f"--- page {i + 1} ---\n{page_text}")
                texts_llm.append(f"--- page {i + 1} ---\n{page_text}")
                for ln in page_text.splitlines():
                    s = ln.strip()
                    if s:
                        lines.append(
                            {"text": s, "score": 1.0, "box": None, "page": i + 1, "kind": "text"}
                        )
        page_count = len(reader.pages)
        engine = "pypdf"
        table_total = 0

    # 复杂页整页渲图（上限 PDF_VISION_MAX_PAGES）
    render_idxs = [
        i
        for i, p in enumerate(pages_out)
        if p.get("complex") or p.get("needs_vision")
    ][:max_vision_pages]
    rendered = _render_pdf_pages_jpeg(data, render_idxs, dpi=render_dpi)
    for idx, blob in rendered.items():
        if 0 <= idx < len(pages_out):
            pages_out[idx]["image_base64"] = blob["base64"]
            pages_out[idx]["image_mime"] = blob["mime"]
            pages_out[idx]["needs_vision"] = True
            pages_out[idx]["suggested_tier"] = 3
            rs = list(pages_out[idx].get("reasons") or [])
            if "page_render" not in rs:
                rs.append("page_render")
            pages_out[idx]["reasons"] = rs

    full_text = "\n\n".join(texts).strip()
    full_text_llm = "\n\n".join(texts_llm).strip() or full_text
    body_chars = sum(len((p.get("text") or "").strip()) for p in pages_out)
    vision_pages = [int(p["page"]) for p in pages_out if p.get("image_base64")]
    any_complex = any(bool(p.get("complex")) for p in pages_out)
    any_needs_vision = any(bool(p.get("needs_vision")) for p in pages_out) or bool(vision_pages)

    reasons: list[str] = []
    if body_chars < 20:
        reasons.append("sparse_text")
    if table_total >= 1:
        reasons.append("table_like")
    if any_complex:
        reasons.append("page_complex")
    if vision_pages:
        reasons.append("vision_pages")

    # 提取元数据：复杂/渲图页仅标记；suggested_tier 不强制对话路由（PDF 不抬 floor）
    is_complex = bool(any_complex or any_needs_vision or body_chars < 20)
    # 几乎无字时提示需要视觉；否则保持 1（对话仍由意图分类器决定 2/3）
    suggested_tier = 3 if (body_chars < 20 or any(bool(p.get("needs_vision")) for p in pages_out)) else 1

    return {
        "success": True,
        "source": "pdf",
        "engine": engine,
        "text": full_text,
        "text_llm": full_text_llm,
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
            "needs_vision": any_needs_vision,
            # 提取阶段：复杂页走渲图而非「用 LLM 做第 2 梯队抽文本」；对话路由不跳过 tier2
            "extract_skip_tier2": True,
            "vision_pages": vision_pages,
            "reasons": reasons,
            "metrics": {
                "page_count": page_count,
                "char_count": body_chars,
                "line_count": len(lines),
                "table_count": table_total,
                "vision_page_count": len(vision_pages),
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
    if result:
        for item in result:
            # item: [box, text, score]
            box, text, score = item[0], item[1], item[2]
            lines.append(
                {
                    "text": str(text),
                    "score": float(score) if score is not None else None,
                    "box": box,
                }
            )

    # 预览用：保持引擎原始行序；送模用：阅读顺序整理后的纯文本
    full_text = "\n".join(str(ln["text"]) for ln in lines).strip()
    text_llm = image_lines_to_llm_text(lines) or full_text
    img_h, img_w = int(arr.shape[0]), int(arr.shape[1])
    out = {
        "success": True,
        "source": "image",
        "engine": "rapidocr",
        "text": full_text,
        "text_llm": text_llm,
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