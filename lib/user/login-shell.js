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
    '<button type="button" class="register-tab active" data-rtab="code" role="tab" aria-selected="true">扫码登录</button>' +
    '<button type="button" class="register-tab" data-rtab="pwd" role="tab" aria-selected="false">密码登录</button>' +
    "</div>" +
    '<p id="registerSuperAuthHint" class="register-super-auth-hint" hidden></p>' +
    '<div id="registerTabCode" class="register-tab-panel active">' +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerCodeUsernameInput" class="register-field-input register-field-input--ghost" type="text" autocomplete="username" placeholder="用户名" aria-label="用户名" />' +
    "</div>" +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerCodePhoneInput" class="register-field-input register-field-input--ghost" type="text" inputmode="numeric" autocomplete="tel" placeholder="手机号" aria-label="手机号" />' +
    "</div>" +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerCodeEmailInput" class="register-field-input register-field-input--ghost" type="email" autocomplete="email" placeholder="邮箱" aria-label="邮箱" />' +
    "</div>" +
    '<div class="register-code-qr-section" id="registerScanCol">' +
    '<div class="register-qr-wrap register-qr-wrap--inline">' +
    '<img id="cameraQrImg" alt="登录二维码" width="140" height="140" />' +
    "</div>" +
    '<p class="register-qr-hint register-qr-hint--inline">填写上方信息后，用手机相机扫描二维码获取验证码</p>' +
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
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerSmsCodeInput" class="register-field-input register-field-input--ghost" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码" aria-label="验证码" />' +
    '<span id="registerSendCodeCooldownLabel" class="register-send-code-cooldown"></span>' +
    "</div>" +
    '<button type="button" id="registerLoginCodeBtn" class="register-primary-btn">登录</button>' +
    '<p id="registerLoginStatusCode" class="register-login-status" aria-live="polite"></p>' +
    "</div>" +
    '<div id="registerTabPwd" class="register-tab-panel" role="tabpanel">' +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerPhoneInput" class="register-field-input register-field-input--ghost" type="text" inputmode="numeric" autocomplete="tel" placeholder="手机号" aria-label="手机号" />' +
    "</div>" +
    '<div class="register-input-line register-input-line--stack">' +
    '<input id="registerPwdInput" class="register-field-input register-field-input--ghost pwd-no-safari-strong" type="text" autocomplete="off" placeholder="密码" aria-label="密码" />' +
    "</div>" +
    '<button type="button" id="registerSubmitBtn" class="register-primary-btn">登录</button>' +
    '<p id="registerLoginStatusPwd" class="register-login-status" aria-live="polite"></p>' +
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
})();
