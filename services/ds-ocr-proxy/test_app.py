"""轻量冒烟：不依赖真实 OCR / DeepSeek。"""

from __future__ import annotations

import base64
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

import app as proxy


def _png_data_url() -> str:
    # 1x1 PNG
    raw = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def test_health_and_models():
    c = TestClient(proxy.app)
    h = c.get("/health")
    assert h.status_code == 200
    assert h.json()["ok"] is True
    assert "ds-ocr" in h.json()["models"]
    assert "ds-ocr-think" in h.json()["models"]

    m = c.get("/v1/models")
    assert m.status_code == 200
    ids = {x["id"] for x in m.json()["data"]}
    assert ids == {"ds-ocr", "ds-ocr-think"}


def test_resolve_model_thinking():
    assert proxy.resolve_model("ds-ocr")["thinking"] is False
    assert proxy.resolve_model("ds-ocr-think")["thinking"] is True


def test_build_upstream_body_thinking_flags():
    body = {"model": "ds-ocr", "messages": [], "stream": False}
    off = proxy.build_upstream_body(body, [{"role": "user", "content": "hi"}], False)
    assert off["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in off
    assert off["model"] == proxy._DEEPSEEK_MODEL

    on = proxy.build_upstream_body(body, [{"role": "user", "content": "hi"}], True)
    assert on["thinking"] == {"type": "enabled"}
    assert "reasoning_effort" in on


def test_strip_and_collect_images():
    msgs = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "读图"},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
            ],
        }
    ]
    imgs = proxy.collect_images_from_messages(msgs)
    assert len(imgs) == 1
    assert imgs[0][0] == "image/png"
    cleaned = proxy.strip_images_from_messages(msgs)
    assert cleaned[0]["content"] == "读图"


def test_chat_completions_no_image_mocks_deepseek():
    proxy._DEEPSEEK_KEY = "sk-test"
    proxy._PROXY_KEY = ""

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.text = json.dumps(
        {
            "id": "chatcmpl-x",
            "choices": [{"message": {"role": "assistant", "content": "pong"}}],
        }
    )
    mock_resp.json.return_value = {
        "id": "chatcmpl-x",
        "choices": [{"message": {"role": "assistant", "content": "pong"}}],
    }

    class FakeClient:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *a: Any) -> None:
            return None

        async def post(
            self,
            url: str,
            headers: dict | None = None,
            json: Any = None,
            **kwargs: Any,
        ):
            assert "/chat/completions" in url
            assert json["thinking"] == {"type": "disabled"}
            assert json["model"] == proxy._DEEPSEEK_MODEL
            assert "reasoning_effort" not in json
            return mock_resp

    with patch.object(proxy.httpx, "AsyncClient", FakeClient):
        c = TestClient(proxy.app)
        r = c.post(
            "/v1/chat/completions",
            json={
                "model": "ds-ocr",
                "messages": [{"role": "user", "content": "只回复pong"}],
                "max_tokens": 16,
            },
        )
    assert r.status_code == 200
    data = r.json()
    assert data["model"] == "ds-ocr"
    assert data["hzdv_ocr"]["thinking"] is False
    assert data["hzdv_ocr"]["images"] == 0


def test_chat_completions_think_and_ocr():
    proxy._DEEPSEEK_KEY = "sk-test"
    proxy._PROXY_KEY = ""
    proxy._OCR_BASE = "http://ocr.test"
    proxy._OCR_KEY = "ocr-key"

    ocr_resp = MagicMock()
    ocr_resp.status_code = 200
    ocr_resp.json.return_value = {"success": True, "text": "屏幕上写着 HELLO"}

    ds_resp = MagicMock()
    ds_resp.status_code = 200
    ds_resp.text = "{}"
    ds_resp.json.return_value = {
        "id": "chatcmpl-y",
        "choices": [{"message": {"role": "assistant", "content": "看到 HELLO"}}],
    }

    posts: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *a: Any) -> None:
            return None

        async def post(
            self,
            url: str,
            headers: dict | None = None,
            json: Any = None,
            **kwargs: Any,
        ):
            posts.append({"url": url, "headers": headers, "json": json})
            if url.endswith("/ocr/base64"):
                assert headers.get("X-API-Key") == "ocr-key"
                assert "image" in json
                return ocr_resp
            assert json["thinking"] == {"type": "enabled"}
            assert "reasoning_effort" in json
            # OCR 文本已拼进 user content
            content = json["messages"][-1]["content"]
            assert "HELLO" in content
            assert "image_url" not in str(json["messages"])
            return ds_resp

    with patch.object(proxy.httpx, "AsyncClient", FakeClient):
        c = TestClient(proxy.app)
        r = c.post(
            "/v1/chat/completions",
            json={
                "model": "ds-ocr-think",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "图里写什么"},
                            {
                                "type": "image_url",
                                "image_url": {"url": _png_data_url()},
                            },
                        ],
                    }
                ],
            },
        )
    assert r.status_code == 200
    data = r.json()
    assert data["model"] == "ds-ocr-think"
    assert data["hzdv_ocr"]["thinking"] is True
    assert data["hzdv_ocr"]["images"] == 1
    assert any(p["url"].endswith("/ocr/base64") for p in posts)


if __name__ == "__main__":
    test_health_and_models()
    test_resolve_model_thinking()
    test_build_upstream_body_thinking_flags()
    test_strip_and_collect_images()
    test_chat_completions_no_image_mocks_deepseek()
    test_chat_completions_think_and_ocr()
    print("all ok")
