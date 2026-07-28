#!/usr/bin/env python3
"""Dump first N pages of test0.pdf: raw vs normalized tables."""
from __future__ import annotations

import sys

import pdfplumber

from app import _find_page_tables, _format_table_block, _is_real_table


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/test0.pdf"
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    with pdfplumber.open(path) as pdf:
        for pi in range(min(max_pages, len(pdf.pages))):
            page = pdf.pages[pi]
            print("\n" + "=" * 60)
            print(f"PAGE {pi + 1}")
            all_t = list(page.find_tables() or [])
            kept = _find_page_tables(page)
            print(f"find_tables={len(all_t)} kept_real={len(kept)}")
            for ti, t in enumerate(all_t):
                rows = t.extract() or []
                real = _is_real_table(rows)
                hdr = ""
                if rows:
                    hdr = " | ".join(
                        (str(c) if c else "")[:24] for c in (rows[0] or [])[:5]
                    )
                print(f"  raw T{ti} real={real} rows={len(rows)} hdr={hdr!r}")
                if not real:
                    continue
                for ri, row in enumerate(rows[:4]):
                    lens = [len(str(c or "").splitlines()) for c in row]
                    print(f"    raw R{ri} lines/col={lens}")
                preview, _llm = _format_table_block(rows)
                print("--- PREVIEW ---")
                print(preview[:3500])
                if len(preview) > 3500:
                    print("... truncated ...")


if __name__ == "__main__":
    main()
