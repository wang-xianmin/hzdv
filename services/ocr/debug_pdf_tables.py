#!/usr/bin/env python3
"""Debug pdfplumber table extraction for test PDFs."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pdfplumber

# Import app helpers when run inside container /app
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import (  # noqa: E402
    _format_table_block,
    _merge_soft_wrap_lines,
    _normalize_table_matrix,
    run_pdf_bytes,
)


def dump_raw_tables(pdf_path: str) -> None:
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            print("\n" + "=" * 24 + f" PAGE {pi + 1} " + "=" * 24)
            tables = page.find_tables()
            print(f"tables: {len(tables)}")
            for ti, t in enumerate(tables):
                rows = t.extract() or []
                print(f"\n--- Table {ti} bbox={tuple(round(x, 1) for x in t.bbox)} rows={len(rows)} ---")
                for ri, row in enumerate(rows):
                    print(f"ROW {ri}:")
                    for ci, cell in enumerate(row):
                        text = "" if cell is None else str(cell)
                        lines = text.split("\n")
                        print(f"  COL{ci} ({len(lines)} lines):")
                        for li, ln in enumerate(lines):
                            print(f"    {li:02d}: {ln!r}")


def dump_normalized(pdf_path: str) -> None:
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            print("\n" + "#" * 24 + f" NORMALIZED PAGE {pi + 1} " + "#" * 24)
            tables = page.find_tables()
            for ti, t in enumerate(tables):
                rows = t.extract() or []
                preview, llm = _format_table_block(rows)
                print(f"\n=== Table {ti} ===")
                print(preview[:6000])
                if len(preview) > 6000:
                    print("\n... truncated ...")


def dump_api(pdf_path: str) -> None:
    data = run_pdf_bytes(Path(pdf_path).read_bytes())
    print(json.dumps(
        {
            "page_count": data.get("page_count"),
            "table_count": data.get("table_count"),
            "engine": data.get("engine"),
            "text_preview": (data.get("text") or "")[:8000],
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/test0.pdf"
    mode = sys.argv[2] if len(sys.argv) > 2 else "all"
    if mode in ("raw", "all"):
        dump_raw_tables(path)
    if mode in ("norm", "all"):
        dump_normalized(path)
    if mode in ("api", "all"):
        dump_api(path)
