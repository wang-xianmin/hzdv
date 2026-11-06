/**
 * GET /passkey/register-scan?sid=xxx
 *
 * 手机扫码注册落地页：在手机上执行 navigator.credentials.create()，私钥留在手机；
 * 完成后把 credential 交给 /api/passkey/qr/register/verify。
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
<title>注册 HZDV 通行密钥</title>
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
  <h1>注册通行密钥</h1>
  <p id="passkeyRegisterScanStatus">正在准备本机创建…</p>
  <p>私钥将安全保存在这台手机上。请完成系统指纹 / 面容验证。</p>
  <button id="passkeyRegisterScanBtn" type="button" hidden>创建通行密钥</button>
</div>
<script>window.PASSKEY_REGISTER_SCAN_SID = ${JSON.stringify(safeSid)};</script>
<script src="/lib/user/passkey-auth.js?v=20261106qr1"></script>
<script src="/lib/user/passkey-qr-register-scan.js?v=20261106qr1"></script>
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
