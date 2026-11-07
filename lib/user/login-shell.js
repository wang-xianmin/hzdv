(function () {
  "use strict";

  var html =
    '<div class="lreg-root">' +
    '<div class="register-panel" id="registerPanel" aria-hidden="true">' +
    '<div class="register-dialog">' +
    '<button type="button" class="register-close" id="registerCloseBtn" aria-label="关闭">&times;</button>' +
    '<div class="register-dev-toolbar" id="registerDevToolbar" hidden>' +
    '<span class="register-dev-toolbar-title">开发调试</span>' +
    '<label class="register-dev-toolbar-label">' +
    '<input type="checkbox" id="registerDebugBypassTurnstile" />' +
    '跳过人机验证' +
    "</label>" +
    "</div>" +
    '<div class="register-split-inner register-split-inner--single">' +
    '<div class="register-col-form">' +
    '<div class="register-tabs" role="tablist">' +
    '<button type="button" class="register-tab active" data-rtab="code" role="tab" aria-selected="true">相机扫码登录</button>' +
    '<button type="button" class="register-tab" data-rtab="wx" role="tab" aria-selected="false">微信扫码登录</button>' +
    '<button type="button" class="register-tab" data-rtab="pwd" role="tab" aria-selected="false">密码登录</button>' +
    '<button type="button" class="register-tab" data-rtab="passkey" role="tab" aria-selected="false" id="registerTabPasskeyBtn" hidden>通行密钥</button>' +
    "</div>" +
    '<p id="registerSuperAuthHint" class="register-super-auth-hint" hidden></p>' +
    '<div id="registerTabCode" class="register-tab-panel active" data-code-step="form">' +
    '<div class="register-input-line register-input-line--stack" id="registerCodePhoneLine">' +
    '<input id="registerCodePhoneInput" class="register-field-input register-field-input--ghost" type="text" inputmode="numeric" autocomplete="tel" placeholder="手机号" aria-label="手机号" />' +
    "</div>" +
    '<div class="register-code-email-row" id="registerCodeEmailLine">' +
    '<button type="button" class="register-code-back-btn" id="registerCodeBackBtn" aria-label="返回修改" title="返回修改" hidden>' +
    '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="11" fill="#161823"/>' +
    '<path d="M13.2 7.2 L8.4 12 l4.8 4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M8.8 12 H16.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    "</svg>" +
    "</button>" +
    '<div class="register-input-line register-input-line--stack register-code-email-field">' +
    '<input id="registerCodeEmailInput" class="register-field-input register-field-input--ghost" type="email" autocomplete="email" placeholder="邮箱" aria-label="邮箱" />' +
    "</div>" +
    "</div>" +
    '<button type="button" id="registerCodeContinueBtn" class="register-primary-btn">' +
    "继续" +
    "</button>" +
    '<div class="register-code-qr-section" id="registerScanCol" hidden>' +
    '<div class="register-qr-wrap register-qr-wrap--inline">' +
    '<img id="cameraQrImg" alt="登录二维码" width="140" height="140" />' +
    "</div>" +
    '<div id="registerQrCountdown" class="register-qr-countdown"></div>' +
    '<div id="actionWrap" class="action-wrap" style="display:none">' +
    '<div class="form-inner-container">' +
    '<div class="input-row user-info-row">' +
    '<label>用户名</label><input id="usernameInput" type="text" />' +
    "</div>" +
    '<div class="input-row user-info-row">' +
    '<label>邮箱</label><input id="emailInput" type="email" />' +
    "</div>" +
    '<div class="input-row user-info-row">' +
    '<label>手机</label><input id="phoneInput" type="text" inputmode="numeric" />' +
    "</div>" +
    '<div class="input-row user-info-row">' +
    '<label>验证码</label><input id="codeInput" type="text" />' +
    '<span id="codeTimer"></span>' +
    "</div>" +
    '<div class="input-row auth-row" style="display:none">' +
    '<label>授权码</label><input id="authCodeInput" type="text" />' +
    "</div>" +
    '<button type="button" id="submitBtn" class="submit-btn">提交</button>' +
    "</div>" +
    "</div>" +
    "</div>" +
    '<p id="registerLoginStatusCode" class="register-login-status" aria-live="polite"></p>' +
    "</div>" +
    '<div id="registerTabWx" class="register-tab-panel" role="tabpanel">' +
    '<div class="register-code-qr-section" id="registerWxQrSection" hidden>' +
    '<div class="register-qr-wrap register-qr-wrap--inline">' +
    '<img id="registerWxQrImg" alt="微信登录二维码" width="200" height="200" hidden />' +
    "</div>" +
    "</div>" +
    '<p id="registerWxHint" class="register-wx-hint" style="text-align:center;font-size:13px;color:#555;margin:8px 0 0"></p>' +
    '<p id="registerLoginStatusWx" class="register-login-status" aria-live="polite"></p>' +
    "</div>" +
    '<div id="registerTabPwd" class="register-tab-panel" role="tabpanel">' +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerPhoneInput" class="register-field-input register-field-input--ghost" type="text" inputmode="numeric" autocomplete="tel" placeholder="手机号" aria-label="手机号" />' +
    "</div>" +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerPwdInput" class="register-field-input register-field-input--ghost pwd-no-safari-strong" type="text" autocomplete="off" placeholder="密码" aria-label="密码" />' +
    "</div>" +
    '<div class="register-turnstile-inline" id="registerPwdTurnstileMount" aria-label="人机验证"></div>' +
    '<button type="button" id="registerSubmitBtn" class="register-primary-btn">登录</button>' +
    '<p id="registerLoginStatusPwd" class="register-login-status" aria-live="polite"></p>' +
    "</div>" +
    '<div id="registerTabPasskey" class="register-tab-panel" role="tabpanel">' +
    '<p class="register-super-auth-hint">用手机扫码（跨设备）或本机指纹 / 面容登录 HZDV。</p>' +
    '<div id="registerPasskeyQrBox" style="display:flex;justify-content:center;margin:10px 0;"></div>' +
    '<p id="registerPasskeyQrAccount" class="register-login-status" aria-live="polite" hidden></p>' +
    '<p id="registerPasskeyQrCountdown" class="register-qr-countdown"></p>' +
    '<button type="button" id="registerPasskeyLocalBtn" style="display:block;margin:10px auto 0;padding:6px 10px;border:0;background:transparent;color:#1f4b7a;font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;">使用本机通行密钥</button>' +
    '<p id="registerLoginStatusPasskey" class="register-login-status" aria-live="polite"></p>' +
    "</div>" +
    "</div>" +
    "</div>" +
    "</div>" +
    "</div>" +
    '<div class="turnstile-overlay" id="turnstileOverlay" aria-hidden="true">' +
    '<div class="turnstile-card">' +
    '<div id="turnstileWidgetMount"></div>' +
    "</div>" +
    '<button type="button" class="turnstile-cancel-btn" id="turnstileCancelBtn">取消</button>' +
    "</div>" +
    "</div>";

  var mount = document.createElement("div");
  mount.innerHTML = html;
  document.body.appendChild(mount.firstElementChild);

  // ── 通行密钥登录 Tab（默认页内自绘二维码；本机通行密钥为次要入口）──
  (function initPasskeyLoginTab() {
    var tabBtn = document.getElementById("registerTabPasskeyBtn");
    var panel = document.getElementById("registerTabPasskey");
    var localBtn = document.getElementById("registerPasskeyLocalBtn");
    var status = document.getElementById("registerLoginStatusPasskey");
    if (!tabBtn || !panel || !localBtn || !status) return;

    function setStatus(text, kind) {
      status.textContent = text || "";
      status.classList.remove("is-ok", "is-error", "is-pending");
      if (kind) status.classList.add("is-" + kind);
    }

    // 扫码登录不依赖桌面端 WebAuthn，Tab 常显；仅隐藏不支持的本机入口
    tabBtn.hidden = false;
    if (!window.PublicKeyCredential) {
      localBtn.hidden = true;
    }

    // 打开 Tab 时生成二维码（懒解析：passkey-qr.js 晚于本文件加载）
    tabBtn.addEventListener("click", function () {
      var qr = window.HZDVPasskeyQr;
      if (qr && typeof qr.start === "function") qr.start();
    });

    // 扫码登录不再有「确认登录」按钮：检测到请求后由 passkey-qr.js 自动 claim 完成登录

    // 次要入口：本机通行密钥（系统 WebAuthn UI）
    localBtn.addEventListener("click", function () {
      // 懒解析：login-shell.js 早于 passkey-login.js 加载，不能在加载期缓存引用
      var api = window.HZDVPasskeyLogin;
      if (!api || typeof api.loginWithPasskey !== "function") {
        setStatus("验证失败，请重试", "error");
        return;
      }
      localBtn.disabled = true;
      setStatus("正在等待系统验证…", "pending");
      Promise.resolve()
        .then(function () {
          return api.loginWithPasskey();
        })
        .then(function (res) {
          localBtn.disabled = false;
          var user = (res && res.result && res.result.user) || {};
          var qr = window.HZDVPasskeyQr;
          if (qr && typeof qr.applyDesktopLogin === "function") {
            qr.applyDesktopLogin(user);
          }
          setStatus("登录成功", "ok");
        })
        .catch(function (err) {
          localBtn.disabled = false;
          // 失败只在面板内提示：不自动切换 Tab、不关闭弹层、不降级到密码/扫码
          setStatus(
            err && err.kind === "notallowed"
              ? "此设备上没有可用的通行密钥，或你取消了选择。"
              : "验证失败，请重试",
            "error"
          );
        });
    });
  })();
})();
