/**
 * Passkey QR 登录 · 手机落地页控制器。
 * 流程：challenge → navigator.credentials.get() → verify（手机端不持有任何会话）。
 */
(function (global) {
  "use strict";

  var statusEl = document.getElementById("passkeyScanStatus");
  var btn = document.getElementById("passkeyScanBtn");
  var running = false;

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove("ok", "err");
    if (kind) statusEl.classList.add(kind);
  }

  function getSid() {
    var sid = global.PASSKEY_SCAN_SID;
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
        setStatus("此设备不支持通行密钥，请改用其它设备登录。", "err");
        showButton();
        return;
      }
      var auth = global.HZDVPasskeyAuth;
      if (!auth || typeof auth.fetchJSON !== "function") {
        setStatus("页面加载异常，请刷新重试。", "err");
        showButton();
        return;
      }

      setStatus("正在请求验证信息…");
      var data = await auth.fetchJSON("/api/passkey/qr/challenge?sid=" + encodeURIComponent(sid), {
        method: "POST",
      });
      var publicKey = data && data.publicKey;
      if (!publicKey) throw new Error("bad_options");

      if (typeof publicKey.challenge === "string") {
        publicKey.challenge = auth.base64urlToBuffer(publicKey.challenge);
      }
      if (Array.isArray(publicKey.allowCredentials)) {
        publicKey.allowCredentials = publicKey.allowCredentials.map(function (c) {
          var copy = Object.assign({}, c);
          if (typeof copy.id === "string") copy.id = auth.base64urlToBuffer(copy.id);
          return copy;
        });
      }

      setStatus("请完成本机指纹 / 面容验证…");
      var credential = await navigator.credentials.get({ publicKey: publicKey });
      if (!credential) throw new Error("no_credential");

      var payload = auth.credentialToJSON(credential);
      await auth.fetchJSON("/api/passkey/qr/verify", {
        method: "POST",
        body: { session_id: sid, credential: payload },
      });
      setStatus("验证成功，请回到电脑完成登录。", "ok");
    } catch (err) {
      // 手机端不泄露后端细节；仅区分"需要用户手势"与"验证未通过"
      var needGesture = err && (err.name === "NotAllowedError" || err.name === "InvalidStateError");
      if (needGesture) {
        setStatus("请点击下方按钮完成本机验证。");
        showButton();
      } else {
        setStatus("验证未通过，请重试或返回电脑改用其它方式登录。", "err");
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
