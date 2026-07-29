/**
 * ASR 代理：浏览器 → /api/asr → VPS 上的 Python + sherpa-onnx 服务
 *
 * 环境变量（Cloudflare Pages）：
 *   ASR_SERVICE_URL  例 https://asr.example.com 或 http://host:8090（须域名，勿裸 IP）
 *   ASR_API_KEY      可选，与容器 ASR_API_KEY 一致
 *
 * POST multipart: file=<audio>
 * POST JSON: { audio: "data:audio/...;base64,..." } 或纯 base64
 * GET  /api/asr → 上游 /health
 */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function asrBase(env) {
  const raw = (env && (env.ASR_SERVICE_URL || env.ASR_URL)) || "";
  return String(raw).trim().replace(/\/+$/, "");
}

function asrKey(env) {
  return String((env && env.ASR_API_KEY) || "").trim();
}

async function forward(env, path, init) {
  const base = asrBase(env);
  if (!base) {
    return jsonResponse(
      {
        success: false,
        error:
          "ASR_SERVICE_URL 未配置。请在 Pages 环境变量中设置，并在 VPS 上 docker compose 启动 services/asr。",
      },
      503
    );
  }
  const headers = new Headers(init.headers || {});
  const key = asrKey(env);
  if (key) headers.set("X-API-Key", key);

  let upstream;
  try {
    upstream = await fetch(base + path, { ...init, headers });
  } catch (e) {
    return jsonResponse(
      {
        success: false,
        error: "无法连接 ASR 服务：" + String((e && e.message) || e),
      },
      502
    );
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return jsonResponse(
      {
        success: false,
        error: "ASR 服务返回非 JSON",
        status: upstream.status,
        body: text.slice(0, 500),
      },
      502
    );
  }
  return jsonResponse(data, upstream.status);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return forward(env, "/health", { method: "GET" });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const ctype = request.headers.get("content-type") || "";

  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return jsonResponse({ success: false, error: "缺少 file 字段" }, 400);
    }
    const out = new FormData();
    out.append("file", file, file.name || "upload.bin");
    return forward(env, "/asr", { method: "POST", body: out });
  }

  if (ctype.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    }
    return forward(env, "/asr/base64", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  return jsonResponse(
    { success: false, error: "Expected multipart/form-data or application/json" },
    400
  );
}
