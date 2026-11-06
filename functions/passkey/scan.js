/**
 * GET /passkey/scan?sid=xxx
 * 手机落地页（OpenRouter 式跨设备扫码登录）：加载后自动、静默地
 * challenge → navigator.credentials.get() → verify；不支持 WebAuthn 时给出明确提示。
 *
 * 说明：页面与桌面同源（origin 必须在 PASSKEY_ALLOWED_ORIGINS 内），
 * rpId 固定 hzdv.net，因此手机上的 WebAuthn 可用。
 */

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const url = new URL(request.url);
  const sid = String(url.searchParams.get("sid") || "").trim();
  const safeSid = sid.replace(/[^0-9a-fA-F-]/g, "");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<title>登录 HZDV</title>
<style>
  body { margin: 0; padding: 32px 20px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color: #161823; background: #fff; }
  .wrap { max-width: 420px; margin: 0 auto; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 8px 0; color: #555; }
  button { margin-top: 18px; padding: 12px 22px; font: inherit; border: 0; border-radius: 10px; background: #161823; color: #fff; cursor: pointer; }
  button[hidden] { display: none; }
  .ok { color: #2b8a3e; }
  .err { color: #c92a2a; }
</style>
</head>
<body>
<div class="wrap">
  <h1>登录 HZDV</h1>
  <p id="passkeyScanStatus">正在准备本机验证…</p>
  <p>请在手机上完成指纹 / 面容验证。</p>
  <button id="passkeyScanBtn" type="button" hidden>开始验证</button>
</div>
<script>window.PASSKEY_SCAN_SID = ${JSON.stringify(safeSid)};</script>
<script src="/lib/user/passkey-auth.js?v=20261106t1"></script>
<script src="/lib/user/passkey-qr-scan.js?v=20261106t1"></script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
