/**
 * OCR 代理：浏览器 → /api/ocr → VPS 上的 Python+RapidOCR+ONNX 服务
 *
 * 环境变量（Cloudflare Pages）：
 *   OCR_SERVICE_URL  例 https://ocr.example.com 或 http://x.x.x.x:8089
 *   OCR_API_KEY      可选，与容器 OCR_API_KEY 一致
 *
 * POST multipart: file=<image>
 * POST JSON: { image: "data:image/...;base64,..." } 或纯 base64
 */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function ocrBase(env) {
  const raw = (env && (env.OCR_SERVICE_URL || env.OCR_URL)) || "";
  return String(raw).trim().replace(/\/+$/, "");
}

function ocrKey(env) {
  return String((env && env.OCR_API_KEY) || "").trim();
}

async function forward(env, path, init) {
  const base = ocrBase(env);
  if (!base) {
    return jsonResponse(
      {
        success: false,
        error:
          "OCR_SERVICE_URL 未配置。请在 Pages 环境变量中设置，并在 VPS 上 docker compose 启动 services/ocr。",
      },
      503
    );
  }
  const headers = new Headers(init.headers || {});
  const key = ocrKey(env);
  if (key) headers.set("X-API-Key", key);

  let upstream;
  try {
    upstream = await fetch(base + path, { ...init, headers });
  } catch (e) {
    return jsonResponse(
      {
        success: false,
        error: "无法连接 OCR 服务：" + String((e && e.message) || e),
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
        error: "OCR 服务返回非 JSON",
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
    // 健康检查代理
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
    return forward(env, "/ocr", { method: "POST", body: out });
  }

  if (ctype.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
    }
    return forward(env, "/ocr/base64", {
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
