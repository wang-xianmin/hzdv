"""HZDV ds-ocr 代理：Cursor / Trae 用的 OpenAI 兼容网关。

模型：
  - ds-ocr        → DeepSeek，关闭思考；有图先 OCR 再送模
  - ds-ocr-think  → DeepSeek，开启思考；有图先 OCR 再送模

环境变量：
  DEEPSEEK_API_KEY     必填（或请求头 X-DeepSeek-Api-Key）
  DEEPSEEK_BASE_URL    默认 https://api.deepseek.com
  DEEPSEEK_MODEL       默认 deepseek-flash
  OCR_SERVICE_URL      默认 http://127.0.0.1:8089
  OCR_API_KEY          与 OCR 服务一致（可选）
  DS_OCR_PROXY_API_KEY 本服务鉴权（可选；Cursor 填进 OpenAI API Key）
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

app = FastAPI(title="hzdv-ds-ocr-proxy", version="0.1.0")

_cors = os.getenv("DS_OCR_CORS_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors.split(",") if o.strip()] or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_PROXY_KEY = (os.getenv("DS_OCR_PROXY_API_KEY") or "").strip()
_DEEPSEEK_KEY = (os.getenv("DEEPSEEK_API_KEY") or "").strip()
_DEEPSEEK_BASE = (
    os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
).strip().rstrip("/")
_DEEPSEEK_MODEL = (os.getenv("DEEPSEEK_MODEL") or "deepseek-flash").strip()
_OCR_BASE = (
    os.getenv("OCR_SERVICE_URL") or os.getenv("OCR_URL") or "http://127.0.0.1:8089"
).strip().rstrip("/")
_OCR_KEY = (os.getenv("OCR_API_KEY") or "").strip()
_UPSTREAM_TIMEOUT = float(os.getenv("DS_OCR_UPSTREAM_TIMEOUT", "180") or "180")
_CONNECT_TIMEOUT = float(os.getenv("DS_OCR_CONNECT_TIMEOUT", "15") or "15")
_OCR_TIMEOUT = float(os.getenv("DS_OCR_OCR_TIMEOUT", "60") or "60")

MODEL_IDS = {
    "ds-ocr": {"thinking": False},
    "ds-ocr-think": {"thinking": True},
}


def assert_proxy_key(authorization: str | None, x_api_key: str | None) -> None:
    if not _PROXY_KEY:
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    got = (x_api_key or "").strip() or bearer
    if got != _PROXY_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def resolve_deepseek_key(header_key: str | None) -> str:
    key = (header_key or "").strip() or _DEEPSEEK_KEY
    if not key:
        raise HTTPException(
            status_code=503,
            detail="缺少 DEEPSEEK_API_KEY（环境变量或 X-DeepSeek-Api-Key）",
        )
    return key


def resolve_model(name: str) -> dict[str, Any]:
    mid = (name or "").strip()
    if mid not in MODEL_IDS:
        # 兼容：未知名默认关思考，仍走 OCR 管线
        if mid.startswith("ds-ocr"):
            return {"thinking": "think" in mid}
        raise HTTPException(
            status_code=400,
            detail="未知模型。请使用 ds-ocr 或 ds-ocr-think",
        )
    return dict(MODEL_IDS[mid])


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "hzdv-ds-ocr-proxy",
        "models": list(MODEL_IDS.keys()),
        "deepseek_model": _DEEPSEEK_MODEL,
        "deepseek_base": _DEEPSEEK_BASE,
        "ocr_base": _OCR_BASE,
        "auth_required": bool(_PROXY_KEY),
        "deepseek_key_configured": bool(_DEEPSEEK_KEY),
    }


@app.get("/v1/models")
@app.get("/models")
def list_models(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    assert_proxy_key(authorization, x_api_key)
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": mid,
                "object": "model",
                "created": now,
                "owned_by": "hzdv-ds-ocr",
            }
            for mid in MODEL_IDS
        ],
    }


def _extract_data_url(url: str) -> tuple[str, bytes] | None:
    m = re.match(
        r"^data:(image/[\w.+-]+);base64,(.+)$",
        (url or "").strip(),
        flags=re.DOTALL,
    )
    if not m:
        return None
    mime = m.group(1)
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except Exception:
        return None
    if not raw:
        return None
    return mime, raw


def collect_images_from_messages(messages: list[Any]) -> list[tuple[str, bytes]]:
    """从 OpenAI 多模态 content 块里抽出图片 bytes。"""
    out: list[tuple[str, bytes]] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            continue
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            ptype = str(part.get("type") or "")
            if ptype == "image_url":
                iu = part.get("image_url")
                url = ""
                if isinstance(iu, dict):
                    url = str(iu.get("url") or "")
                elif isinstance(iu, str):
                    url = iu
                got = _extract_data_url(url)
                if got:
                    out.append(got)
            elif ptype == "input_image":
                # Responses / 部分客户端
                url = str(part.get("image_url") or part.get("url") or "")
                got = _extract_data_url(url)
                if got:
                    out.append(got)
            elif ptype == "image" and part.get("source"):
                src = part.get("source")
                if isinstance(src, dict) and src.get("type") == "base64":
                    data = str(src.get("data") or "")
                    mime = str(src.get("media_type") or "image/png")
                    try:
                        raw = base64.b64decode(data, validate=False)
                        if raw:
                            out.append((mime, raw))
                    except Exception:
                        pass
    return out


def strip_images_from_messages(messages: list[Any]) -> list[dict[str, Any]]:
    """去掉 image 块，只留文本（OCR 结果会另拼）。"""
    cleaned: list[dict[str, Any]] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        m = dict(msg)
        content = m.get("content")
        if isinstance(content, list):
            texts: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    texts.append(str(part.get("text") or ""))
                elif isinstance(part, str):
                    texts.append(part)
            m["content"] = "\n".join(t for t in texts if t).strip()
        cleaned.append(m)
    return cleaned


async def ocr_image(client: httpx.AsyncClient, mime: str, raw: bytes) -> str:
    if not _OCR_BASE:
        return ""
    b64 = base64.b64encode(raw).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"
    headers = {"Content-Type": "application/json"}
    if _OCR_KEY:
        headers["X-API-Key"] = _OCR_KEY
    try:
        # OCR 服务：JSON base64 走 /ocr/base64（/ocr 是 multipart 上传）
        resp = await client.post(
            _OCR_BASE + "/ocr/base64",
            headers=headers,
            json={"image": data_url, "filename": "cursor.png"},
            timeout=httpx.Timeout(_OCR_TIMEOUT, connect=_CONNECT_TIMEOUT),
        )
    except Exception as e:
        return f"[OCR 失败: {e}]"
    if resp.status_code >= 400:
        return f"[OCR HTTP {resp.status_code}: {resp.text[:200]}]"
    try:
        data = resp.json()
    except Exception:
        return "[OCR 返回非 JSON]"
    if isinstance(data, dict):
        if data.get("success") is False:
            return f"[OCR 错误: {data.get('error') or data}]"
        text = data.get("text")
        if text is None and isinstance(data.get("lines"), list):
            text = "\n".join(
                str(x.get("text") or "")
                for x in data["lines"]
                if isinstance(x, dict)
            )
        return str(text or "").strip()
    return ""


async def enrich_messages_with_ocr(
    client: httpx.AsyncClient, messages: list[Any]
) -> tuple[list[dict[str, Any]], list[str]]:
    images = collect_images_from_messages(messages)
    cleaned = strip_images_from_messages(messages)
    ocr_texts: list[str] = []
    for i, (mime, raw) in enumerate(images, start=1):
        text = await ocr_image(client, mime, raw)
        if text:
            ocr_texts.append(f"【OCR 图{i}】\n{text}")
        else:
            ocr_texts.append(f"【OCR 图{i}】\n（无文字）")

    if not ocr_texts:
        return cleaned, []

    block = (
        "以下为附带图片经本地 OCR 识别的文字（原图未送给语言模型）：\n\n"
        + "\n\n".join(ocr_texts)
    )
    # 拼到最后一条 user 消息；若没有 user，追加一条
    for i in range(len(cleaned) - 1, -1, -1):
        if cleaned[i].get("role") == "user":
            prev = cleaned[i].get("content") or ""
            if isinstance(prev, list):
                prev = ""
            cleaned[i]["content"] = (str(prev).rstrip() + "\n\n" + block).strip()
            return cleaned, ocr_texts
    cleaned.append({"role": "user", "content": block})
    return cleaned, ocr_texts


def build_upstream_body(
    body: dict[str, Any],
    messages: list[dict[str, Any]],
    thinking: bool,
) -> dict[str, Any]:
    out = dict(body)
    out["model"] = _DEEPSEEK_MODEL
    out["messages"] = messages
    # DeepSeek：关思考必须显式 disabled，且不要带 reasoning_effort
    if thinking:
        out["thinking"] = {"type": "enabled"}
        if "reasoning_effort" not in out:
            out["reasoning_effort"] = os.getenv("DS_OCR_REASONING_EFFORT", "high")
    else:
        out["thinking"] = {"type": "disabled"}
        out.pop("reasoning_effort", None)
    # 去掉 Cursor 可能带来、DeepSeek 不认的杂项（保留常见字段）
    for k in list(out.keys()):
        if k.startswith("_"):
            out.pop(k, None)
    return out


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_deepseek_api_key: str | None = Header(
        default=None, alias="X-DeepSeek-Api-Key"
    ),
) -> Response:
    assert_proxy_key(authorization, x_api_key)
    ds_key = resolve_deepseek_key(x_deepseek_api_key)

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid JSON") from e
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body 须为 JSON 对象")

    req_model = str(body.get("model") or "ds-ocr").strip()
    cfg = resolve_model(req_model)
    thinking = bool(cfg.get("thinking"))
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="缺少 messages")

    want_stream = bool(body.get("stream"))
    timeout = httpx.Timeout(_UPSTREAM_TIMEOUT, connect=_CONNECT_TIMEOUT)
    started = time.time()

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        enriched, ocr_notes = await enrich_messages_with_ocr(client, messages)
        upstream_body = build_upstream_body(body, enriched, thinking)
        if _DEEPSEEK_BASE.endswith("/v1"):
            url = _DEEPSEEK_BASE + "/chat/completions"
        else:
            url = _DEEPSEEK_BASE + "/v1/chat/completions"

        headers = {
            "Authorization": "Bearer " + ds_key,
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if want_stream else "application/json",
        }

        if want_stream:
            upstream_client = httpx.AsyncClient(
                timeout=timeout, follow_redirects=True
            )

            async def event_stream() -> AsyncIterator[bytes]:
                try:
                    # 首包注释：便于调试 OCR
                    if ocr_notes:
                        meta = {
                            "id": "chatcmpl-dsocr-" + uuid.uuid4().hex[:10],
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": req_model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "role": "assistant",
                                        "content": "",
                                    },
                                    "finish_reason": None,
                                }
                            ],
                            "hzdv_ocr": {
                                "images": len(ocr_notes),
                                "thinking": thinking,
                            },
                        }
                        yield (
                            "data: "
                            + json.dumps(meta, ensure_ascii=False)
                            + "\n\n"
                        ).encode("utf-8")

                    async with upstream_client.stream(
                        "POST", url, headers=headers, json=upstream_body
                    ) as upstream:
                        if upstream.status_code >= 400:
                            err_body = await upstream.aread()
                            try:
                                err_txt = err_body.decode(
                                    "utf-8", errors="replace"
                                )
                            except Exception:
                                err_txt = "upstream error"
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "error": {
                                            "message": err_txt[:1200],
                                            "status": upstream.status_code,
                                        }
                                    },
                                    ensure_ascii=False,
                                )
                                + "\n\n"
                            ).encode("utf-8")
                            yield b"data: [DONE]\n\n"
                            return
                        async for chunk in upstream.aiter_bytes():
                            if chunk:
                                yield chunk
                except httpx.TimeoutException:
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "error": {
                                    "message": "deepseek timeout",
                                    "latency_ms": int(
                                        (time.time() - started) * 1000
                                    ),
                                }
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    ).encode("utf-8")
                    yield b"data: [DONE]\n\n"
                finally:
                    await upstream_client.aclose()

            return StreamingResponse(
                event_stream(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "X-HZDV-Model": req_model,
                    "X-HZDV-Thinking": "1" if thinking else "0",
                    "X-HZDV-OCR-Images": str(len(ocr_notes)),
                },
            )

        try:
            upstream = await client.post(
                url, headers=headers, json=upstream_body
            )
        except httpx.TimeoutException as e:
            raise HTTPException(status_code=504, detail="DeepSeek timeout") from e

        text = upstream.text
        try:
            data = upstream.json()
        except Exception:
            raise HTTPException(
                status_code=502,
                detail="DeepSeek 返回非 JSON: " + text[:400],
            )

        if isinstance(data, dict):
            data["model"] = req_model
            data["hzdv_ocr"] = {
                "images": len(ocr_notes),
                "thinking": thinking,
                "upstream_model": _DEEPSEEK_MODEL,
            }

        return Response(
            content=json.dumps(data, ensure_ascii=False),
            status_code=upstream.status_code,
            media_type="application/json",
            headers={
                "X-HZDV-Model": req_model,
                "X-HZDV-Thinking": "1" if thinking else "0",
                "X-HZDV-OCR-Images": str(len(ocr_notes)),
            },
        )
