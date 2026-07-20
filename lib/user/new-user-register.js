/**
 * L_ENG 新人注册页面
 * 业务逻辑在 login.js
 */
(function () {
    'use strict';

    // ── 1. 注入 CSS ──
    var style = document.createElement('style');
    style.id = 'l-eng-newuser-register-styles';
    style.textContent =
        '.newuser-register-panel{display:none;position:fixed;left:0;right:0;bottom:84px;z-index:158;padding:0 24px;box-sizing:border-box}' +
        '.newuser-register-panel.show{display:block}' +
        '.newuser-register-card{position:relative;width:min(420px,94vw);margin:0 auto;padding:28px 22px 32px;border-radius:16px;background:#3b38a3;box-shadow:0 10px 36px rgba(35,32,120,0.45);box-sizing:border-box}' +
        '.newuser-register-close{position:absolute;top:10px;right:12px;width:36px;height:36px;border:none;background:transparent;color:rgba(255,255,255,0.85);font-size:26px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}' +
        '.newuser-register-close:hover{color:#fff}' +
        '.newuser-register-title{margin:0 0 16px;padding:0 40px 0 0;font-size:20px;font-weight:700;color:#fff;text-align:left;letter-spacing:0.04em}' +
        '.newuser-register-fields{display:flex;flex-direction:column;gap:14px;margin-top:0}' +
        '.newuser-reg-field{display:flex;align-items:stretch;background:#fff;border-radius:12px;overflow:hidden;min-height:48px;box-shadow:0 2px 8px rgba(0,0,0,0.12)}' +
        '.newuser-reg-field--phone{align-items:center;overflow:hidden;padding:5px 6px 5px 0;box-sizing:border-box}' +
        '.newuser-reg-field--phone .newuser-reg-input{padding-top:12px;padding-bottom:12px}' +
        '.newuser-reg-arrow-slot{flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:4px 4px 4px calc(0.5em + 2px);box-sizing:border-box}' +
        '.newuser-reg-input{flex:1;min-width:0;border:none;outline:none;padding:14px 16px;font-size:16px;color:#1a1a1a;background:#fff}' +
        '.newuser-reg-input::placeholder{color:#9a9a9a}' +
        '.newuser-reg-arrow-btn{flex-shrink:0;width:44px;height:34px;border:none;border-radius:8px;background:#3b38a3;color:#fff;font-size:16px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;box-sizing:border-box}' +
        '.newuser-reg-arrow-btn:hover{filter:brightness(1.08)}' +
        '.newuser-reg-invite-wrap{display:flex;align-items:center;justify-content:flex-start;gap:10px}' +
        '.newuser-reg-invite-label{flex:0 0 auto;font-size:13px;font-weight:600;color:#e5e7eb;white-space:nowrap;user-select:none}' +
        '.newuser-reg-invite-wrap .newuser-reg-field{flex:0 0 210px;width:210px}' +
        '.newuser-reg-input--invite{width:100%;padding-left:12px;padding-right:12px}' +
        '.pwd-no-safari-strong{-webkit-text-security:disc}' +
        '@supports(text-security:disc){.pwd-no-safari-strong{text-security:disc}}' +
        '.register-kv-preview{display:none;width:min(600px,94vw);margin:0 auto 12px;padding:12px 14px;box-sizing:border-box;background:rgba(255,255,255,0.95);border-radius:10px;color:#222;font-size:12px;max-height:42vh;overflow:auto}' +
        '.register-kv-save-status{margin:10px 0 0;font-size:12px;font-weight:600;color:#2b8a3e}' +
        '.register-kv-save-status.is-error{color:#c92a2a}' +
        '.register-kv-section{margin-bottom:12px}' +
        '.register-kv-section:last-child{margin-bottom:0}' +
        '.register-kv-title{font-weight:700;color:#2e30c7;margin-bottom:6px;font-size:13px}' +
        '.register-kv-pre{margin:0;padding:8px 10px;background:#f4f4f8;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.45}';
    document.head.appendChild(style);

    // ── 2. 注入 HTML ──
    var container = document.createElement('div');
    container.innerHTML =
        '<div class="newuser-register-panel" id="newUserRegisterPanel" aria-hidden="true">' +
            '<div id="newUserKvPreview" class="register-kv-preview" aria-live="polite">' +
                '<div class="register-kv-section">' +
                    '<div class="register-kv-title">Key</div>' +
                    '<pre class="register-kv-pre" id="newUserKvKeyText"></pre>' +
                '</div>' +
                '<div class="register-kv-section">' +
                    '<div class="register-kv-title">Value（JSON）</div>' +
                    '<pre class="register-kv-pre" id="newUserKvValueJson"></pre>' +
                '</div>' +
                '<div class="register-kv-section">' +
                    '<div class="register-kv-title">Metadata（JSON）</div>' +
                    '<pre class="register-kv-pre" id="newUserKvMetadataJson"></pre>' +
                '</div>' +
                '<p id="newUserKvSaveStatus" class="register-kv-save-status" hidden></p>' +
            '</div>' +
            '<div class="newuser-register-card" role="dialog" aria-labelledby="newUserRegisterTitle">' +
                '<button type="button" class="newuser-register-close" id="newUserRegisterCloseBtn" aria-label="关闭">&times;</button>' +
                '<h2 id="newUserRegisterTitle" class="newuser-register-title">新人注册</h2>' +
                '<div class="newuser-register-fields">' +
                    '<div class="newuser-reg-field">' +
                        '<input type="text" id="newUserRegNameInput" class="newuser-reg-input" placeholder="用户名(昵称)：二呆" autocomplete="username" />' +
                    '</div>' +
                    '<div class="newuser-reg-field newuser-reg-field--phone">' +
                        '<input type="text" id="newUserRegPhoneInput" class="newuser-reg-input" placeholder="手机号是唯一标识（仅数字）" inputmode="numeric" pattern="[0-9]*" autocomplete="tel" maxlength="20" />' +
                        '<div class="newuser-reg-arrow-slot">' +
                            '<button type="button" class="newuser-reg-arrow-btn" id="newUserRegPhoneNextBtn" aria-label="下一步"><span aria-hidden="true">-&gt;</span></button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="newuser-reg-field">' +
                        '<input type="text" id="newUserRegPwdInput" class="newuser-reg-input pwd-no-safari-strong" placeholder="密码:123456" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="text" aria-label="密码" data-form-type="other" />' +
                    '</div>' +
                    '<div class="newuser-reg-invite-wrap" id="newUserRegInviteRow" hidden>' +
                        '<label for="newUserRegInviteCodeInput" class="newuser-reg-invite-label">邀请码</label>' +
                        '<div class="newuser-reg-field">' +
                            '<input type="text" id="newUserRegInviteCodeInput" class="newuser-reg-input newuser-reg-input--invite" placeholder="六位数字" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" aria-label="邀请码六位数字" />' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(container.firstElementChild);

})();
