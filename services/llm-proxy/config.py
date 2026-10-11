"""HZDV LLM 代理：可插拔模型壳配置。

设计（管理员 Web 面板 → 写运行时 conf）：
  - 模型「定义」是代码内静态目录 MODEL_CATALOG（provider/base/vision/thinking 默认已知）。
  - 模型「启用表 + provider 密钥」由运行时 JSON 文件控制（面板写入；config.py 每次请求实时读，
    改完即生效，无需重启容器）。文件路径由 env LLM_PROXY_MODELS_CONF 指定（默认 /app/models.conf）。
  - 同时面板会把同样内容回写到项目 .env（持久化，供 docker compose 下次 up 读取，不强制）。

这样「配置表用 env/file + 面板点选」都满足，且避免了每次改模型都要 rebuild。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

CONF_PATH = os.getenv("LLM_PROXY_MODELS_CONF", "/app/models.conf")


@dataclass(frozen=True)
class Provider:
    name: str
    base: str            # upstream base URL（不含 /chat/completions）
    key_env: str         # 该 provider 的 API key 所在环境变量名（运行时 conf 覆盖时用 key 值）
    label: str           # 面板显示用


# 支持的 provider（base URL 对齐 OpenAI 兼容 /chat/completions）
PROVIDERS: dict[str, Provider] = {
    "deepseek": Provider(
        name="deepseek",
        base="https://api.deepseek.com",
        key_env="DEEPSEEK_API_KEY",
        label="DeepSeek",
    ),
    "qwen": Provider(
        name="qwen",
        # 阿里云百炼 OpenAI 兼容模式
        base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        key_env="DASHSCOPE_API_KEY",
        label="阿里云百炼 Qwen",
    ),
    "siliconflow": Provider(
        name="siliconflow",
        base="https://api.siliconflow.cn/v1",
        key_env="SILICONFLOW_API_KEY",
        label="SiliconFlow",
    ),
}


@dataclass(frozen=True)
class ModelShell:
    id: str                 # 客户端可选的模型名（如 qwen3.7-plus）
    provider: str           # provider name
    upstream_model: str     # 实际转发给上游的模型 id
    vision: bool            # 是否自带图像理解（true=原样传图；false=走 OCR）
    thinking: bool          # 默认是否 thinking
    label: str = ""         # 面板显示名


def _m(id_: str, provider: str, upstream: str | None = None, *,
       vision: bool = False, thinking: bool = False, label: str = "") -> ModelShell:
    return ModelShell(
        id=id_,
        provider=provider,
        upstream_model=upstream if upstream else id_,
        vision=vision,
        thinking=thinking,
        label=label or id_,
    )


# 模型目录（静态定义）。面板里可勾选；勾选后经运行时 conf 启用。
MODEL_CATALOG: list[ModelShell] = [
    _m("ds-ocr", "deepseek", "deepseek-flash", vision=False, thinking=False, label="ds-ocr (DeepSeek Flash 非思考)"),
    _m("ds-ocr-thinking", "deepseek", "deepseek-flash", vision=False, thinking=True, label="ds-ocr-thinking (DeepSeek Flash 思考)"),
    _m("qwen3.7-plus", "qwen", vision=False, thinking=False, label="qwen3.7-plus"),
    _m("qwen-plus-2025-07-28", "qwen", "qwen-plus", vision=False, thinking=False, label="qwen-plus-2025-07-28"),
    _m("glm-5", "qwen", vision=False, thinking=False, label="glm-5 (百炼托管)"),
    _m("deepseek-r1-distill-qwen-7b", "qwen", "qwen-flash", vision=False, thinking=False, label="deepseek-r1-distill-qwen-7b"),
    _m("qwen3-vl-235b-a22b-thinking", "qwen", "qwen3-vl-plus", vision=True, thinking=True, label="qwen3-vl-235b-a22b-thinking"),
    _m("deepseek-v4-pro", "deepseek", "deepseek-v4-pro", vision=False, thinking=False, label="deepseek-v4-pro (DeepSeek V4 Pro)"),
]


def _default_enabled() -> list[str]:
    # 官方默认：全量模型放库、默认全开；管理员在面板里取消勾选即可关闭。
    return [s.id for s in MODEL_CATALOG]


def _read_conf() -> dict[str, Any]:
    """读运行时配置 {enabled:[...], provider_keys:{provider:key}}。读不到/损坏则返回空。"""
    try:
        if not os.path.exists(CONF_PATH):
            return {}
        obj = json.loads(open(CONF_PATH, encoding="utf-8").read())
        if not isinstance(obj, dict):
            return {}
        return obj
    except Exception:
        return {}


def load_enabled_ids() -> list[str]:
    conf = _read_conf()
    if isinstance(conf.get("enabled"), list):
        # conf 明确写了 enabled（面板保存过）：尊重，含空数组（用户全灭）
        valid = {s.id for s in MODEL_CATALOG}
        return [str(x) for x in conf["enabled"] if str(x) in valid]
    # 无 conf / 未配置 enabled → env 兜底，再默认全量
    raw = (os.getenv("MODELS_ENABLED") or "").strip()
    if raw:
        try:
            a2 = json.loads(raw)
            if isinstance(a2, list):
                valid = {s.id for s in MODEL_CATALOG}
                return [str(x) for x in a2 if str(x) in valid]
        except Exception:
            pass
    return _default_enabled()


def provider_keys() -> dict[str, str]:
    """provider 名 → 上游 API key。优先 conf，其次 env。"""
    conf = _read_conf()
    conf_keys = conf.get("provider_keys")
    out: dict[str, str] = {}
    for pname, prov in PROVIDERS.items():
        k = ""
        if isinstance(conf_keys, dict) and conf_keys.get(pname):
            k = str(conf_keys[pname]).strip()
        if not k:
            k = (os.getenv(prov.key_env) or "").strip()
        out[pname] = k
    return out


def catalog_map() -> dict[str, ModelShell]:
    return {s.id: s for s in MODEL_CATALOG}


def get_shell(model_id: str) -> ModelShell | None:
    return catalog_map().get(model_id)


def provider_for(shell: ModelShell) -> Provider:
    return PROVIDERS[shell.provider]


def provider_key_configured(shell: ModelShell) -> bool:
    return bool(provider_keys().get(shell.provider))


def enabled_shells() -> list[ModelShell]:
    out = []
    keys = provider_keys()
    for mid in load_enabled_ids():
        s = catalog_map().get(mid)
        if not s:
            continue
        if not keys.get(s.provider):
            continue
        out.append(s)
    return out


def is_builtin(mid: str) -> bool:
    return mid in catalog_map()


def all_catalog_json() -> list[dict[str, Any]]:
    items = []
    for s in MODEL_CATALOG:
        prov = PROVIDERS[s.provider]
        items.append({
            "id": s.id,
            "label": s.label,
            "provider": s.provider,
            "provider_label": prov.label,
            "upstream_model": s.upstream_model,
            "base": prov.base,
            "vision": s.vision,
            "thinking": s.thinking,
        })
    return items
