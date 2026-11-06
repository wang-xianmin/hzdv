/**
 * Passkey QR 注册 · 手机落地页控制器。
 * 流程：options → navigator.credentials.create() → verify；私钥保留在手机。
 */
(function (global) {
  "use strict";

  var statusEl = document.getElementById("passkeyRegisterScanStatus");
  var btn = document.getElementById("passkeyRegisterScanBtn");
  var running = false;

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove("ok", "err");
    if (kind) statusEl.classList.add(kind);
  }

  function getSid() {
    var sid = global.PASSKEY_REGISTER_SCAN_SID;
    if (!sid) {
      try {
        var m = /[?&]sid=([^&]+)/.exec(global.location.search || "");
        sid = m ? decodeURIComponent(m[1]) : "";
      } catch (e) {
        sid = "";
      }
    }
    return String(sid || "").trim();
  }

  function showButton() {
    if (btn) btn.hidden = false;
  }

  async function run() {
    if (running) return;
    running = true;
    if (btn) btn.disabled = true;
    try {
      var sid = getSid();
      if (!sid) {
        setStatus("链接无效，请回到电脑重新扫码。", "err");
        showButton();
        return;
      }
      if (!global.PublicKeyCredential) {
        setStatus("此设备不支持通行密钥。", "err");
        showButton();
        return;
      }
      var auth = global.HZDVPasskeyAuth;
      if (!auth || typeof auth.fetchJSON !== "function") {
        setStatus("页面加载异常，请刷新重试。", "err");
        showButton();
        return;
      }

      setStatus("正在请求创建信息…");
      var data = await auth.fetchJSON("/api/passkey/qr/register/options?sid=" + encodeURIComponent(sid), {
        method: "POST",
      });
      var publicKey = data && data.publicKey;
      if (!publicKey) throw new Error("bad_options");

      if (typeof publicKey.challenge === "string") {
        publicKey.challenge = auth.base64urlToBuffer(publicKey.challenge);
      }
      if (publicKey.user && typeof publicKey.user.id === "string") {
        publicKey.user = Object.assign({}, publicKey.user, {
          id: auth.base64urlToBuffer(publicKey.user.id),
        });
      }
      if (Array.isArray(publicKey.excludeCredentials)) {
        publicKey.excludeCredentials = publicKey.excludeCredentials.map(function (c) {
          var copy = Object.assign({}, c);
          if (typeof copy.id === "string") copy.id = auth.base64urlToBuffer(copy.id);
          return copy;
        });
      }

      setStatus("请完成本机指纹 / 面容验证…");
      var credential = await navigator.credentials.create({ publicKey: publicKey });
      if (!credential) throw new Error("no_credential");

      var payload = auth.credentialToJSON(credential);
      await auth.fetchJSON("/api/passkey/qr/register/verify?sid=" + encodeURIComponent(sid), {
        method: "POST",
        body: { session_id: sid, credential: payload },
      });
      setStatus("注册成功，请回到电脑。", "ok");
    } catch (err) {
      var needGesture = err && (err.name === "NotAllowedError" || err.name === "InvalidStateError");
      if (needGesture) {
        setStatus("请点击下方按钮完成本机创建。");
        showButton();
      } else {
        setStatus("注册未完成，请重试或返回电脑稍后再试。", "err");
        showButton();
      }
    } finally {
      running = false;
      if (btn) btn.disabled = false;
    }
  }

  if (btn) {
    btn.addEventListener("click", function () {
      run();
    });
  }

  run();
})(typeof window !== "undefined" ? window : globalThis);
