"""HZDV LLM 代理：CF Pages 短连本服务，由本机长超时转发到云端 OpenAI 兼容 API。

鉴权：Authorization Bearer 或 X-API-Key = LLM_PROXY_API_KEY
Body：标准 chat/completions JSON（model / messages / …）
stream=true 时透传上游 SSE（解决 CF 墙钟：连接保持期间可持续推流）

可插拔模型壳（Cursor / Trae「添加模型」直接用，Base URL = https://llm.hzdv.net/v1）：
  模型定义在 config.MODEL_CATALOG；启用表由 env MODELS_ENABLED（JSON）控制，
  管理员在 Web 配置面板勾选 → 覆写 .env。
  能力路由：
    - vision=false（如 ds-ocr / qwen3.7-plus）→ 图片先经 hzdv-ocr 识别成文字再送 LLM
    - vision=true（如 qwen3-vl-*）→ 多模态原样透传给上游 VL 模型，不 OCR
  客户端鉴权：DS_OCR_API_KEY 或 LLM_PROXY_API_KEY；
  上游密钥：各 provider 独立 env（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / SILICONFLOW_API_KEY）。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import re
import time
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import config

app = FastAPI(title="hzdv-llm-proxy", version="0.4.0")

_cors = os.getenv("LLM_PROXY_CORS_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors.split(",") if o.strip()] or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_API_KEY = (os.getenv("LLM_PROXY_API_KEY") or "").strip()
_UPSTREAM_TIMEOUT = float(os.getenv("LLM_PROXY_UPSTREAM_TIMEOUT", "180") or "180")
_CONNECT_TIMEOUT = float(os.getenv("LLM_PROXY_CONNECT_TIMEOUT", "15") or "15")

# 客户端鉴权 key（IDE 表现用的那把）——保留 ds 命名兼容旧版
_DS_OCR_KEY = (os.getenv("DS_OCR_API_KEY") or "").strip()
_OCR_URL = (os.getenv("DS_OCR_OCR_URL") or "http://host.docker.internal:8089").strip().rstrip("/")
_OCR_KEY = (os.getenv("DS_OCR_OCR_API_KEY") or "").strip()
_OCR_CACHE_MAX = 200
_ocr_cache: dict[str, str] = {}


def _upstream_model_re(shell: config.ModelShell) -> re.Pattern[bytes]:
    return re.compile(rb'"model"\s*:\s*"' + re.escape(shell.upstream_model.encode()) + rb'"')


def _client_key(authorization: str | None, x_api_key: str | None) -> str:
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    return (x_api_key or "").strip() or bearer


def assert_api_key(
    authorization: str | None,
    x_api_key: str | None,
) -> None:
    if not _API_KEY:
        return
    got = _client_key(authorization, x_api_key)
    if got != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def assert_ds_key(authorization: str | None, x_api_key: str | None) -> None:
    keys = [k for k in (_DS_OCR_KEY, _API_KEY) if k]
    if not keys:
        raise HTTPException(status_code=503, detail="未配置 DS_OCR_API_KEY")
    got = _client_key(authorization, x_api_key).encode()
    if not any(hmac.compare_digest(got, k.encode()) for k in keys):
        raise HTTPException(status_code=401, detail="Invalid API key")


def normalize_base(url: str) -> str:
    return (url or "").strip().rstrip("/")


def _upscale_b64(b64: str) -> str:
    # 小字截图会整行漏检，放大到长边约 2000px 后可找回
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(base64.b64decode(b64 + "=" * (-len(b64) % 4))))
        scale = min(2.0, 2000 / max(im.size))
        if scale < 1.1:
            return b64
        im = im.convert("RGB").resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return b64


async def _ocr_text(client: httpx.AsyncClient, b64: str) -> str:
    h = hashlib.sha256(b64.encode("ascii", "ignore")).hexdigest()
    if h in _ocr_cache:
        return _ocr_cache[h]
    headers = {"Content-Type": "application/json"}
    if _OCR_KEY:
        headers["X-API-Key"] = _OCR_KEY
    image = await asyncio.to_thread(_upscale_b64, b64)
    r = await client.post(_OCR_URL + "/ocr/base64", json={"image": image}, headers=headers)
    r.raise_for_status()
    data = r.json()
    text = str(data.get("text_llm") or data.get("text") or "").strip()
    _ocr_cache[h] = text
    while len(_ocr_cache) > _OCR_CACHE_MAX:
        _ocr_cache.pop(next(iter(_ocr_cache)))
    return text


def _part_image_url(part: dict[str, Any]) -> str | None:
    if part.get("type") not in ("image_url", "input_image", "image"):
        return None
    iu = part.get("image_url") or part.get("url")
    return str((iu.get("url") if isinstance(iu, dict) else iu) or "")


def _data_url_b64(url: str) -> str:
    head, _, data = url.partition(",")
    if not head.startswith("data:") or ";base64" not in head:
        raise ValueError("只支持 base64 data URL 图片")
    return data.strip()


async def _flatten_content(client: httpx.AsyncClient, content: Any) -> Any:
    """多模态 content → 纯文本；图片先 OCR。DeepSeek 只收文本。"""
    if not isinstance(content, list):
        return content
    out: list[str] = []
    n = 0
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") in ("text", "input_text"):
            out.append(str(part.get("text") or ""))
            continue
        url = _part_image_url(part)
        if url is None:
            continue
        n += 1
        try:
            text = await _ocr_text(client, _data_url_b64(url))
            out.append(f"[图片{n} OCR 识别文字]\n{text or '（未识别到文字）'}\n[/图片{n}]")
        except Exception as e:
            out.append(f"[图片{n} OCR 失败：{e}]")
    return "\n\n".join(s for s in out if s)


async def _build_upstream_body(shell: config.ModelShell, body: dict[str, Any]) -> dict[str, Any]:
    """按壳的能力把请求体重组为上游模型可理解的格式。

    - 上游模型名替换为 shell.upstream_model
    - vision=false：多模态图片先 OCR 成文字（_flatten_content）
    - vision=true：多模态原样透传（VL 模型自己看图）
    """
    up = dict(body)
    up["model"] = shell.upstream_model
    if shell.thinking:
        # Qwen 系列用 enable_thinking 表达思考；DeepSeek 用 thinking.type
        up["thinking"] = {"type": "enabled"}
    msgs = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=_CONNECT_TIMEOUT)) as client:
        for m in body.get("messages") or []:
            if isinstance(m, dict) and "content" in m:
                m = dict(m)
                if shell.vision:
                    # VL 模型：不动 content，保留多模态
                    m["content"] = list(m["content"]) if isinstance(m["content"], list) else m["content"]
                else:
                    m["content"] = await _flatten_content(client, m["content"])
            msgs.append(m)
    up["messages"] = msgs
    return up


def _rename_model(data: bytes, client_model: str | None, shell: config.ModelShell | None = None) -> bytes:
    if not client_model or shell is None:
        return data
    return _upstream_model_re(shell).sub(b'"model":"' + client_model.encode() + b'"', data)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "hzdv-llm-proxy",
        "auth_required": bool(_API_KEY),
        "upstream_timeout_s": _UPSTREAM_TIMEOUT,
        "stream": True,
        "models": [s.id for s in config.enabled_shells()],
    }


@app.get("/v1/models")
@app.get("/models")
def list_models(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    assert_ds_key(authorization, x_api_key)
    now = int(time.time())
    shells = config.enabled_shells()
    return {
        "object": "list",
        "data": [{"id": s.id, "object": "model", "created": now, "owned_by": "hzdv"} for s in shells],
    }


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_upstream_base_url: str | None = Header(default=None, alias="X-Upstream-Base-Url"),
    x_upstream_api_key: str | None = Header(default=None, alias="X-Upstream-Api-Key"),
) -> Response:
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid JSON") from e
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body 须为 JSON 对象")

    client_model: str | None = None
    shell: config.ModelShell | None = None
    if config.is_builtin(body.get("model")):
        # 客户端选的是模型壳
        assert_ds_key(authorization, x_api_key)
        shell = config.get_shell(body.get("model"))
        prov = config.provider_for(shell)
        upstream_key = config.provider_keys().get(shell.provider) or ""
        if not upstream_key:
            raise HTTPException(
                status_code=503,
                detail=f"未配置 {prov.key_env}（{prov.label} 上游密钥）",
            )
        client_model = body["model"]
        body = await _build_upstream_body(shell, body)
        upstream_base = prov.base
    else:
        assert_api_key(authorization, x_api_key)
        upstream_base = normalize_base(x_upstream_base_url or "")
        upstream_key = (x_upstream_api_key or "").strip()
        if not upstream_base:
            raise HTTPException(status_code=400, detail="缺少 X-Upstream-Base-Url")
        if not upstream_key:
            raise HTTPException(status_code=400, detail="缺少 X-Upstream-Api-Key")
        if "{WorkspaceId}" in upstream_base:
            raise HTTPException(status_code=400, detail="X-Upstream-Base-Url 仍含 {WorkspaceId}")

    url = upstream_base + "/chat/completions"
    started = time.time()
    want_stream = bool(body.get("stream"))
    timeout = httpx.Timeout(_UPSTREAM_TIMEOUT, connect=_CONNECT_TIMEOUT)
    headers = {
        "Authorization": "Bearer " + upstream_key,
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if want_stream else "application/json",
    }

    if want_stream:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)

        async def event_stream() -> AsyncIterator[bytes]:
            try:
                async with client.stream(
                    "POST",
                    url,
                    headers=headers,
                    json=body,
                ) as upstream:
                    if upstream.status_code >= 400:
                        err_body = await upstream.aread()
                        # 非 2xx：尽量以单条 SSE error 或原样 JSON 片段回传
                        try:
                            err_txt = err_body.decode("utf-8", errors="replace")
                        except Exception:
                            err_txt = '{"error":{"message":"upstream error"}}'
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "error": {
                                        "message": err_txt[:800],
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
                            yield _rename_model(chunk, client_model, shell)
            except httpx.TimeoutException:
                latency_ms = int((time.time() - started) * 1000)
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "error": {
                                "message": "upstream timeout %sms"
                                % int(_UPSTREAM_TIMEOUT * 1000),
                                "type": "timeout",
                                "latency_ms": latency_ms,
                            }
                        }
                    )
                    + "\n\n"
                ).encode("utf-8")
                yield b"data: [DONE]\n\n"
            except httpx.HTTPError as e:
                latency_ms = int((time.time() - started) * 1000)
                msg = str(e).replace('"', "'")[:300]
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "error": {
                                "message": msg,
                                "type": "proxy_error",
                                "latency_ms": latency_ms,
                            }
                        }
                    )
                    + "\n\n"
                ).encode("utf-8")
                yield b"data: [DONE]\n\n"
            finally:
                await client.aclose()

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Proxy-Stream": "1",
                "X-Proxy-Latency-Ms": str(int((time.time() - started) * 1000)),
            },
        )

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            upstream = await client.post(
                url,
                headers=headers,
                json=body,
            )
    except httpx.TimeoutException:
        latency_ms = int((time.time() - started) * 1000)
        return Response(
            content=(
                '{"error":{"message":"upstream timeout %sms","type":"timeout","latency_ms":%d}}'
                % (int(_UPSTREAM_TIMEOUT * 1000), latency_ms)
            ),
            status_code=504,
            media_type="application/json",
        )
    except httpx.HTTPError as e:
        latency_ms = int((time.time() - started) * 1000)
        msg = str(e).replace('"', "'")[:300]
        return Response(
            content='{"error":{"message":"%s","type":"proxy_error","latency_ms":%d}}'
            % (msg, latency_ms),
            status_code=502,
            media_type="application/json",
        )

    media = upstream.headers.get("content-type") or "application/json"
    return Response(
        content=_rename_model(upstream.content, client_model, shell),
        status_code=upstream.status_code,
        media_type=media.split(";")[0].strip() or "application/json",
        headers={
            "X-Proxy-Upstream-Status": str(upstream.status_code),
            "X-Proxy-Latency-Ms": str(int((time.time() - started) * 1000)),
        },
    )
