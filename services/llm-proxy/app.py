"""HZDV LLM 代理：CF Pages 短连本服务，由本机长超时转发到云端 OpenAI 兼容 API。

鉴权：Authorization Bearer 或 X-API-Key = LLM_PROXY_API_KEY
上游：请求头
  X-Upstream-Base-Url  例如 https://api.siliconflow.cn/v1
  X-Upstream-Api-Key   云厂商密钥（由 CF Secrets 传入，不落盘）
Body：标准 chat/completions JSON（model / messages / …）
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="hzdv-llm-proxy", version="0.1.0")

_cors = os.getenv("LLM_PROXY_CORS_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors.split(",") if o.strip()] or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_API_KEY = (os.getenv("LLM_PROXY_API_KEY") or "").strip()
_UPSTREAM_TIMEOUT = float(os.getenv("LLM_PROXY_UPSTREAM_TIMEOUT", "120") or "120")
_CONNECT_TIMEOUT = float(os.getenv("LLM_PROXY_CONNECT_TIMEOUT", "15") or "15")


def assert_api_key(
    authorization: str | None,
    x_api_key: str | None,
) -> None:
    if not _API_KEY:
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    got = (x_api_key or "").strip() or bearer
    if got != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def normalize_base(url: str) -> str:
    return (url or "").strip().rstrip("/")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "hzdv-llm-proxy",
        "auth_required": bool(_API_KEY),
        "upstream_timeout_s": _UPSTREAM_TIMEOUT,
    }


@app.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_upstream_base_url: str | None = Header(default=None, alias="X-Upstream-Base-Url"),
    x_upstream_api_key: str | None = Header(default=None, alias="X-Upstream-Api-Key"),
) -> Response:
    assert_api_key(authorization, x_api_key)

    upstream_base = normalize_base(x_upstream_base_url or "")
    upstream_key = (x_upstream_api_key or "").strip()
    if not upstream_base:
        raise HTTPException(status_code=400, detail="缺少 X-Upstream-Base-Url")
    if not upstream_key:
        raise HTTPException(status_code=400, detail="缺少 X-Upstream-Api-Key")
    if "{WorkspaceId}" in upstream_base:
        raise HTTPException(status_code=400, detail="X-Upstream-Base-Url 仍含 {WorkspaceId}")

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid JSON") from e
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body 须为 JSON 对象")

    url = upstream_base + "/chat/completions"
    started = time.time()
    timeout = httpx.Timeout(_UPSTREAM_TIMEOUT, connect=_CONNECT_TIMEOUT)

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            upstream = await client.post(
                url,
                headers={
                    "Authorization": "Bearer " + upstream_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
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

    # 原样回传上游状态与正文（便于 CF 侧 extractUpstreamError）
    media = upstream.headers.get("content-type") or "application/json"
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=media.split(";")[0].strip() or "application/json",
        headers={
            "X-Proxy-Upstream-Status": str(upstream.status_code),
            "X-Proxy-Latency-Ms": str(int((time.time() - started) * 1000)),
        },
    )
