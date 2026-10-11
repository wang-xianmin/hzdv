"""HZDV LLM 代理：模型配置 Web 面板（管理员用）。

流程：勾选启用模型 + 填各 provider 密钥 → 保存 → 写运行时 conf（/app/models.conf，
与 llm-proxy 容器共享）→ 实时生效，无需重启。同时把 MODELS_ENABLED/provider keys
镜像写回项目 .env 作为持久化（供 docker compose 下次 up 读取）。
面板只从 config 读取建模信息 + 已配置的 key 是否存在（不泄露密钥原文）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

import config

app = FastAPI(title="hzdv-llm-dashboard", version="0.1.0")

# 运行时 conf 路径（与 llm-proxy 容器通过 volume 共享宿主机同一个文件）
CONF_PATH = Path(config.CONF_PATH)
# 项目 .env 持久化路径（docker compose 环境目录）
ENV_PATH = Path(os.getenv("LLM_PROXY_ENV_PATH", "/app/.env"))


def _read_conf() -> dict[str, object]:
    if not CONF_PATH.exists():
        return {}
    try:
        obj = json.loads(CONF_PATH.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _mirror_env(conf: dict[str, object]) -> None:
    """把 enabled + provider_keys 镜像写回 .env（尽力；失败不影响已落 conf）。"""
    try:
        if not ENV_PATH.exists():
            return
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
        enabled_json = json.dumps(conf.get("enabled", []), ensure_ascii=False)
        keys = conf.get("provider_keys") or {}
        merged = {}  # 保留其它 key，只更新这 3 类
        for line in lines:
            if "=" not in line:
                continue
            k, _, v = line.partition("=")
            merged[k.strip()] = v.strip()
        merged["MODELS_ENABLED"] = enabled_json
        for pname in config.PROVIDERS:
            pe = config.PROVIDERS[pname].key_env
            if isinstance(keys, dict) and keys.get(pname):
                merged[pe] = str(keys[pname])
        out = "\n".join(f"{k}={v}" for k, v in merged.items()) + "\n"
        ENV_PATH.write_text(out, encoding="utf-8")
    except Exception:
        pass


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    conf = _read_conf()
    enabled = list(conf.get("enabled")) if isinstance(conf.get("enabled"), list) else config.load_enabled_ids()
    keys_conf = conf.get("provider_keys") if isinstance(conf.get("provider_keys"), dict) else {}
    # key 是否已配置（不回显明文）
    have_keys = {}
    for pname, prov in config.PROVIDERS.items():
        have_keys[pname] = bool(keys_conf.get(pname)) or bool((os.getenv(prov.key_env) or "").strip())
    page = TEMPLATE
    page = page.replace("__CATALOG__", json.dumps(config.all_catalog_json(), ensure_ascii=False))
    page = page.replace("__ENABLED__", json.dumps(enabled, ensure_ascii=False))
    page = page.replace("__HAVE__", json.dumps(have_keys, ensure_ascii=False))
    page = page.replace("__PROVLABELS__", json.dumps({n: p.label for n, p in config.PROVIDERS.items()}, ensure_ascii=False))
    page = page.replace("__CONFEXISTS__", "1" if CONF_PATH.exists() else "0")
    return page


@app.post("/save")
async def save(request: Request) -> dict[str, object]:
    try:
        payload = await request.json()
    except Exception:
        return {"ok": False, "error": "Invalid JSON"}
    enabled = payload.get("enabled")
    keys = payload.get("provider_keys")
    if not isinstance(enabled, list) or not isinstance(keys, dict):
        return {"ok": False, "error": "非法参数"}

    ids = [i for i in enabled if i in config.catalog_map()]
    clean_keys = {p: str(v).strip() for p, v in keys.items() if p in config.PROVIDERS and str(v).strip()}
    try:
        CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONF_PATH.write_text(json.dumps(
            {"enabled": ids, "provider_keys": clean_keys}, ensure_ascii=False
        ), encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": f"写运行时 conf 失败: {e}"}

    _mirror_env({"enabled": ids, "provider_keys": clean_keys})
    return {"ok": True, "enabled": ids, "note": "已生效（无需重启）"}


TEMPLATE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HZDV LLM 模型配置</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#222}
  h1{font-size:20px} h2{font-size:15px;margin:22px 0 8px}
  .provider{border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin:10px 0}
  .model{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px dashed #eee}
  .model:first-child{border-top:none}
  .model label{flex:1}
  .badge{font-size:11px;padding:1px 6px;border-radius:9px;color:#fff}
  .vision{background:#0a7d33} .no-vision{background:#8a8a8a} .think{background:#b3541e}
  .key-input{width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px;font-family:monospace}
  button{margin-top:14px;padding:10px 22px;border:none;border-radius:8px;background:#007aff;color:#fff;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5}
  #msg{margin-left:12px;font-size:13px}
  .ok{color:#0a7d33} .err{color:#c00}
  .upstream{margin-left:auto;font-size:11px;color:#888}
  .have{color:#0a7d33;font-weight:600}
</style>
</head>
<body>
<h1>HZDV LLM 模型配置面板</h1>
<p style="color:#666;font-size:13px">勾选可用模型 → 填各厂商 API Key → 保存（实时生效，无需重启）。已勾选项会出现在 <code>/v1/models</code> 供各项目 agent 选用（Base URL=<code>https://llm.hzdv.net/v1</code>）。</p>
<div id="confbar" style="font-size:13px;color:#666;margin-bottom:6px"></div>
<div id="providers"></div>

<button id="save" onclick="save()">保存并生效</button><span id="msg"></span>

<script>
const CATALOG = __CATALOG__;
const ENABLED = __ENABLED__;
const HAVE = __HAVE__;
const PROVIDER_LABELS = __PROVLABELS__;
const CONFEXISTS = __CONFEXISTS__;

const confEl = document.getElementById('confbar');
confEl.textContent = CONFEXISTS==='1' ? '运行时配置已存在，当前为实际启用项。' : '尚无运行时配置，正显示默认项（全量模型默认勾选）。保存一次后即写盘。';

function render(){
  const byProv = {};
  CATALOG.forEach(m => { (byProv[m.provider] = byProv[m.provider] || []).push(m); });
  const box = document.getElementById('providers');
  box.innerHTML = '';
  Object.keys(PROVIDER_LABELS).forEach(pid => {
    const models = byProv[pid] || [];
    const div = document.createElement('div');
    div.className = 'provider';
    const haveTxt = HAVE[pid] ? '<span class="have">✓ 已配置 Key</span>' : '<span style="color:#c00">✗ 未配置 Key</span>';
    div.innerHTML = '<h2>' + PROVIDER_LABELS[pid] + ' ' + haveTxt + '</h2>' +
      '<label>API Key（' + pid + '）' + (HAVE[pid]?'（已配置，留空则不修改）':'') + '</label>' +
      '<input class="key-input" data-provider="' + pid + '" placeholder="粘贴 ' + pid + ' 的 API Key" type="password">' +
      '<div style="margin-top:8px">' + models.map(function(m){
        return '<div class="model">' +
          '<input type="checkbox" data-model="' + m.id + '" id="m_' + m.id + '" ' + (ENABLED.includes(m.id)?'checked':'') + '>' +
          '<label for="m_' + m.id + '">' + m.label +
            '<span class="badge ' + (m.vision?'vision':'no-vision') + '">' + (m.vision?'视觉':'OCR') + '</span>' +
            (m.thinking?'<span class="badge think">思考</span>':'') +
          '</label>' +
          '<code class="upstream">' + m.upstream_model + '</code>' +
          '</div>';
      }).join('') + '</div>';
    box.appendChild(div);
  });
}

function save(){
  const enabled = Array.from(document.querySelectorAll('input[data-model]')).filter(c=>c.checked).map(c=>c.dataset.model);
  const keys = {};
  document.querySelectorAll('input[data-provider]').forEach(i => { if(i.value) keys[i.dataset.provider]=i.value; });
  const btn = document.getElementById('save'); btn.disabled = true;
  const msg = document.getElementById('msg'); msg.textContent='保存中…'; msg.className='';
  fetch('/save', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled: enabled, provider_keys: keys})})
    .then(r => r.json())
    .then(d => { msg.textContent = d.ok ? ('已保存并生效。启用: ' + d.enabled.join(', ')) : ('失败: '+(d.error||'')); msg.className = d.ok?'ok':'err'; })
    .catch(e => { msg.textContent='请求失败: '+e; msg.className='err'; })
    .finally(()=> btn.disabled=false);
}

render();
</script>
</body>
</html>
"""