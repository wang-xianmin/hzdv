/**
 * HZDV / L_ENG 个人资料弹层
 * 自旧站 profile.js 迁入；头像备选逻辑保留，数据源改为 leng_user / 登录态。
 *
 * 依赖：app-stubs.js（收据读写）、login.js（备选头像列表）、/api/update-kv-profile
 *
 * 对外：window.L_ENG_Profile / window.openProfileModal / window.openUserProfileModal
 */
(function () {
    'use strict';

    // ================================================================
    // 1. 注入 CSS
    // ================================================================
    function injectProfileCSS() {
        var style = document.createElement('style');
        style.id = 'l-eng-profile-styles';
        style.textContent = '/* 个人资料弹层（iOS / Android 触控与安全区） */\n' +
        '.profile-modal-overlay {\n' +
        '    display: none;\n' +
        '    position: fixed;\n' +
        '    inset: 0;\n' +
        '    z-index: 2100;\n' +
        '    align-items: flex-end;\n' +
        '    justify-content: center;\n' +
        '    padding: 0;\n' +
        '    padding-bottom: env(safe-area-inset-bottom, 0px);\n' +
        '    box-sizing: border-box;\n' +
        '    background: rgba(0, 0, 0, 0.38);\n' +
        '    backdrop-filter: blur(10px);\n' +
        '    -webkit-backdrop-filter: blur(10px);\n' +
        '}\n' +
        '\n' +
        '.profile-modal-overlay.show {\n' +
        '    display: flex;\n' +
        '}\n' +
        '\n' +
        '.profile-modal-sheet {\n' +
        '    width: 100%;\n' +
        '    max-width: min(350px, 100vw);\n' +
        '    max-height: min(92vh, 640px);\n' +
        '    overflow: auto;\n' +
        '    -webkit-overflow-scrolling: touch;\n' +
        '    background: #fff;\n' +
        '    border-radius: 24px 24px 0 0;\n' +
        '    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.18);\n' +
        '    padding: 28px max(20px, env(safe-area-inset-left, 0px)) calc(32px + env(safe-area-inset-bottom, 0px))\n' +
        '        max(20px, env(safe-area-inset-right, 0px));\n' +
        '    box-sizing: border-box;\n' +
        '    position: relative;\n' +
        '    isolation: isolate;\n' +
        '}\n' +
        '\n' +
        '@media (min-width: 480px) {\n' +
        '    .profile-modal-overlay {\n' +
        '        align-items: center;\n' +
        '        padding: 24px;\n' +
        '    }\n' +
        '\n' +
        '    .profile-modal-sheet {\n' +
        '        border-radius: 24px;\n' +
        '    }\n' +
        '}\n' +
        '\n' +
        '.profile-modal-overlay.is-alt .profile-modal-sheet {\n' +
        '    max-width: min(430px, 100vw);\n' +
        '}\n' +
        '\n' +
        '.profile-modal-close {\n' +
        '    position: absolute;\n' +
        '    top: max(10px, env(safe-area-inset-top, 0px));\n' +
        '    right: max(10px, env(safe-area-inset-right, 0px));\n' +
        '    z-index: 20;\n' +
        '    width: 44px;\n' +
        '    height: 44px;\n' +
        '    border: none;\n' +
        '    border-radius: 50%;\n' +
        '    background: #f0f0f2;\n' +
        '    color: #444;\n' +
        '    font-size: 22px;\n' +
        '    line-height: 1;\n' +
        '    cursor: pointer;\n' +
        '    touch-action: manipulation;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '    display: inline-flex;\n' +
        '    align-items: center;\n' +
        '    justify-content: center;\n' +
        '    padding: 0;\n' +
        '    box-sizing: border-box;\n' +
        '    pointer-events: auto;\n' +
        '}\n' +
        '\n' +
        '.profile-modal-close:hover {\n' +
        '    background: #e4e4e8;\n' +
        '}\n' +
        '\n' +
        '.profile-modal-close:active {\n' +
        '    opacity: 0.85;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-wrap {\n' +
        '    position: relative;\n' +
        '    display: flex;\n' +
        '    justify-content: center;\n' +
        '    margin-bottom: 8px;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-source-menu {\n' +
        '    position: absolute;\n' +
        '    left: 50%;\n' +
        '    transform: translateX(-50%);\n' +
        '    top: calc(100% + 10px);\n' +
        '    min-width: 148px;\n' +
        '    padding: 6px 0;\n' +
        '    background: #fff;\n' +
        '    border: 1px solid #e0e0e0;\n' +
        '    border-radius: 12px;\n' +
        '    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);\n' +
        '    z-index: 5;\n' +
        '    box-sizing: border-box;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-source-menu[hidden] {\n' +
        '    display: none !important;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-source-item {\n' +
        '    display: block;\n' +
        '    width: 100%;\n' +
        '    padding: 12px 18px;\n' +
        '    border: none;\n' +
        '    background: transparent;\n' +
        '    text-align: left;\n' +
        '    font-size: 15px;\n' +
        '    color: #222;\n' +
        '    cursor: pointer;\n' +
        '    font-family: inherit;\n' +
        '    touch-action: manipulation;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-source-item:hover,\n' +
        '.profile-avatar-source-item:focus-visible {\n' +
        '    background: #f5f5f7;\n' +
        '    outline: none;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-btn {\n' +
        '    position: relative;\n' +
        '    width: 104px;\n' +
        '    height: 104px;\n' +
        '    padding: 0;\n' +
        '    border: none;\n' +
        '    border-radius: 50%;\n' +
        '    cursor: pointer;\n' +
        '    background: #c9a882;\n' +
        '    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);\n' +
        '    overflow: hidden;\n' +
        '    touch-action: manipulation;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-btn:focus-visible {\n' +
        '    outline: 2px solid #228be6;\n' +
        '    outline-offset: 3px;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-initials {\n' +
        '    font-size: 32px;\n' +
        '    font-weight: 600;\n' +
        '    color: #fff;\n' +
        '    letter-spacing: 0.02em;\n' +
        '    line-height: 1;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-img {\n' +
        '    position: absolute;\n' +
        '    inset: 0;\n' +
        '    width: 100%;\n' +
        '    height: 100%;\n' +
        '    object-fit: cover;\n' +
        '    border-radius: 50%;\n' +
        '}\n' +
        '\n' +
        '.profile-avatar-camera {\n' +
        '    position: absolute;\n' +
        '    right: 4px;\n' +
        '    bottom: 4px;\n' +
        '    width: 30px;\n' +
        '    height: 30px;\n' +
        '    border-radius: 50%;\n' +
        '    background: #fff;\n' +
        '    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);\n' +
        '    display: flex;\n' +
        '    align-items: center;\n' +
        '    justify-content: center;\n' +
        '    font-size: 14px;\n' +
        '    pointer-events: none;\n' +
        '}\n' +
        '\n' +
        '.profile-mode-panel[hidden] {\n' +
        '    display: none !important;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-head {\n' +
        '    display: flex;\n' +
        '    align-items: center;\n' +
        '    justify-content: center;\n' +
        '    margin-bottom: 12px;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-title {\n' +
        '    margin: 0;\n' +
        '    font-size: 16px;\n' +
        '    font-weight: 600;\n' +
        '    color: #222;\n' +
        '    text-align: center;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-inputs {\n' +
        '    display: grid;\n' +
        '    grid-template-columns: 1fr;\n' +
        '    gap: 10px;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-grid {\n' +
        '    margin-top: 14px;\n' +
        '    display: grid;\n' +
        '    gap: 10px;\n' +
        '    max-height: 38vh;\n' +
        '    overflow: auto;\n' +
        '    padding-right: 2px;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-row {\n' +
        '    border: 1px solid #ececf0;\n' +
        '    border-radius: 10px;\n' +
        '    padding: 8px;\n' +
        '    background: #fff;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-row-title {\n' +
        '    margin: 0 0 8px;\n' +
        '    color: #666;\n' +
        '    font-size: 12px;\n' +
        '}\n' +
        '\n' +
        '/* 与 X/Twitter 等时间线头像常见展示一致：约 80×80 CSS 像素一行四格对照 */\n' +
        '.profile-alt-quad {\n' +
        '    display: flex;\n' +
        '    flex-wrap: nowrap;\n' +
        '    gap: 4px;\n' +
        '    align-items: flex-start;\n' +
        '    justify-content: flex-start;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-option {\n' +
        '    border: 1px solid #d8d8de;\n' +
        '    border-radius: 8px;\n' +
        '    background: #fff;\n' +
        '    padding: 0;\n' +
        '    width: 50px;\n' +
        '    min-width: 50px;\n' +
        '    box-sizing: border-box;\n' +
        '    cursor: pointer;\n' +
        '    display: flex;\n' +
        '    flex-direction: column;\n' +
        '    align-items: center;\n' +
        '    gap: 2px;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-option.is-active {\n' +
        '    border-color: #228be6;\n' +
        '    box-shadow: 0 0 0 2px rgba(34, 139, 230, 0.16);\n' +
        '}\n' +
        '\n' +
        '.profile-alt-option img {\n' +
        '    width: 50px;\n' +
        '    height: 50px;\n' +
        '    max-width: 50px;\n' +
        '    max-height: 50px;\n' +
        '    border-radius: 6px;\n' +
        '    display: block;\n' +
        '    object-fit: cover;\n' +
        '    background: #f3f3f5;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-option.is-round img {\n' +
        '    border-radius: 50%;\n' +
        '}\n' +
        '\n' +
        '.profile-alt-option-label {\n' +
        '    font-size: 9px;\n' +
        '    color: #555;\n' +
        '    line-height: 1.15;\n' +
        '    text-align: center;\n' +
        '    max-width: 50px;\n' +
        '    word-break: break-all;\n' +
        '}\n' +
        '\n' +
        '.profile-field {\n' +
        '    margin-top: 14px;\n' +
        '    display: flex;\n' +
        '    align-items: center;\n' +
        '    gap: 10px;\n' +
        '}\n' +
        '\n' +
        '.profile-field-label {\n' +
        '    display: inline-block;\n' +
        '    width: 70px;\n' +
        '    flex: 0 0 70px;\n' +
        '    font-size: 13px;\n' +
        '    color: #86868b;\n' +
        '    margin-bottom: 0;\n' +
        '    font-weight: 500;\n' +
        '    text-align: left;\n' +
        '}\n' +
        '\n' +
        '.profile-field-input {\n' +
        '    width: 320px;\n' +
        '    max-width: 100%;\n' +
        '    box-sizing: border-box;\n' +
        '    font-size: 16px;\n' +
        '    padding: 12px 14px;\n' +
        '    border: 1px solid #d2d2d7;\n' +
        '    border-radius: 14px;\n' +
        '    background: #fff;\n' +
        '    text-align: left;\n' +
        '}\n' +
        '\n' +
        '.profile-field-input:focus {\n' +
        '    outline: none;\n' +
        '    border-color: #228be6;\n' +
        '    box-shadow: 0 0 0 3px rgba(34, 139, 230, 0.2);\n' +
        '}\n' +
        '\n' +
        '.profile-field-input--readonly {\n' +
        '    background: #f5f5f7;\n' +
        '    color: #7a7a80;\n' +
        '    border-color: #e8e8ed;\n' +
        '    cursor: not-allowed;\n' +
        '}\n' +
        '\n' +
        '.profile-password-wrap {\n' +
        '    display: flex;\n' +
        '    align-items: center;\n' +
        '    gap: 8px;\n' +
        '    width: 320px;\n' +
        '    max-width: 100%;\n' +
        '    flex: 1 1 auto;\n' +
        '    min-width: 0;\n' +
        '}\n' +
        '\n' +
        '.profile-password-wrap .profile-field-input {\n' +
        '    width: auto;\n' +
        '    flex: 1 1 auto;\n' +
        '    min-width: 0;\n' +
        '    padding-right: 14px;\n' +
        '}\n' +
        '\n' +
        '.profile-password-toggle {\n' +
        '    position: static;\n' +
        '    flex: 0 0 40px;\n' +
        '    width: 40px;\n' +
        '    height: 40px;\n' +
        '    border: 1px solid #d2d2d7;\n' +
        '    background: #f5f5f7;\n' +
        '    color: #3a3a3c;\n' +
        '    cursor: pointer;\n' +
        '    display: inline-flex;\n' +
        '    align-items: center;\n' +
        '    justify-content: center;\n' +
        '    border-radius: 12px;\n' +
        '    padding: 0;\n' +
        '    transform: none;\n' +
        '    z-index: 2;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '}\n' +
        '\n' +
        '.profile-password-toggle:hover {\n' +
        '    color: #1d1d1f;\n' +
        '    background: #ebebed;\n' +
        '    border-color: #c7c7cc;\n' +
        '}\n' +
        '\n' +
        '.profile-password-toggle:focus-visible {\n' +
        '    outline: none;\n' +
        '    box-shadow: 0 0 0 3px rgba(34, 139, 230, 0.25);\n' +
        '}\n' +
        '\n' +
        '.profile-password-toggle svg {\n' +
        '    width: 20px;\n' +
        '    height: 20px;\n' +
        '    display: block;\n' +
        '    pointer-events: none;\n' +
        '}\n' +
        '\n' +
        '.profile-modal-actions {\n' +
        '    margin-top: 20px;\n' +
        '    display: flex;\n' +
        '    flex-direction: column;\n' +
        '    gap: 10px;\n' +
        '    align-items: center;\n' +
        '}\n' +
        '\n' +
        '.profile-save-btn {\n' +
        '    border: none;\n' +
        '    border-radius: 999px;\n' +
        '    padding: 12px 16px;\n' +
        '    font-size: 16px;\n' +
        '    font-weight: 600;\n' +
        '    color: #fff;\n' +
        '    background: #111;\n' +
        '    cursor: pointer;\n' +
        '    width: 50%;\n' +
        '    max-width: 160px;\n' +
        '    min-height: 44px;\n' +
        '    box-sizing: border-box;\n' +
        '    touch-action: manipulation;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '}\n' +
        '\n' +
        '.profile-save-btn:hover {\n' +
        '    background: #333;\n' +
        '}\n' +
        '\n' +
        '.profile-save-btn:active {\n' +
        '    opacity: 0.9;\n' +
        '}\n' +
        '\n' +
        '.profile-cancel-btn {\n' +
        '    border: none;\n' +
        '    background: none;\n' +
        '    color: #228be6;\n' +
        '    font-size: 16px;\n' +
        '    cursor: pointer;\n' +
        '    padding: 8px 12px;\n' +
        '    width: 50%;\n' +
        '    max-width: 160px;\n' +
        '    min-height: 44px;\n' +
        '    box-sizing: border-box;\n' +
        '    text-align: center;\n' +
        '    touch-action: manipulation;\n' +
        '    -webkit-tap-highlight-color: transparent;\n' +
        '}\n' +
        '\n' +
        '.profile-cancel-btn:active {\n' +
        '    opacity: 0.75;\n' +
        '}';
        document.head.appendChild(style);
    }

    // ================================================================
    // 2. 注入 HTML
    // ================================================================
    function injectProfileHTML() {
        var container = document.createElement('div');
        container.innerHTML = '<!-- 个人资料（新人注册 KV 保存成功后可打开） -->\n' +
        '<div class="profile-modal-overlay" id="profileModalOverlay" aria-hidden="true">\n' +
        '    <div class="profile-modal-sheet" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle">\n' +
        '        <button type="button" class="profile-modal-close" id="profileModalCloseBtn" aria-label="关闭">&times;</button>\n' +
        '        <h2 id="profileModalTitle" class="visually-hidden">个人资料</h2>\n' +
        '        <div id="profileMainPanel" class="profile-mode-panel">\n' +
        '            <div class="profile-avatar-wrap">\n' +
        '                <button\n' +
        '                    type="button"\n' +
        '                    class="profile-avatar-btn"\n' +
        '                    id="profileAvatarBtn"\n' +
        '                    aria-label="更换头像"\n' +
        '                    aria-expanded="false"\n' +
        '                    aria-haspopup="menu"\n' +
        '                    aria-controls="profileAvatarSourceMenu"\n' +
        '                >\n' +
        '                    <img id="profileAvatarImg" class="profile-avatar-img" alt="" width="104" height="104" hidden />\n' +
        '                    <span id="profileAvatarInitials" class="profile-avatar-initials" aria-hidden="true">?</span>\n' +
        '                    <span class="profile-avatar-camera" aria-hidden="true">&#x1F4F7;</span>\n' +
        '                </button>\n' +
        '                <div\n' +
        '                    id="profileAvatarSourceMenu"\n' +
        '                    class="profile-avatar-source-menu"\n' +
        '                    role="menu"\n' +
        '                    hidden\n' +
        '                    aria-hidden="true"\n' +
        '                >\n' +
        '                    <button type="button" class="profile-avatar-source-item" data-avatar-source="camera" role="menuitem">\n' +
        '                        相机\n' +
        '                    </button>\n' +
        '                    <button type="button" class="profile-avatar-source-item" data-avatar-source="alternate" role="menuitem">\n' +
        '                        备选\n' +
        '                    </button>\n' +
        '                    <button type="button" class="profile-avatar-source-item" data-avatar-source="gallery" role="menuitem">\n' +
        '                        图库\n' +
        '                    </button>\n' +
        '                </div>\n' +
        '                <input\n' +
        '                    type="file"\n' +
        '                    id="profileAvatarFileCamera"\n' +
        '                    accept="image/*"\n' +
        '                    capture="environment"\n' +
        '                    hidden\n' +
        '                />\n' +
        '                <input\n' +
        '                    type="file"\n' +
        '                    id="profileAvatarFileGallery"\n' +
        '                    accept="image/*,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp,.gif"\n' +
        '                    hidden\n' +
        '                />\n' +
        '            </div>\n' +
        '            <div class="profile-field">\n' +
        '                <label class="profile-field-label" for="profilePhoneInput">手机号</label>\n' +
        '                <input\n' +
        '                    type="text"\n' +
        '                    id="profilePhoneInput"\n' +
        '                    class="profile-field-input profile-field-input--readonly"\n' +
        '                    readonly\n' +
        '                    disabled\n' +
        '                    aria-readonly="true"\n' +
        '                    aria-label="手机号（不可修改）"\n' +
        '                />\n' +
        '            </div>\n' +
        '            <div class="profile-field">\n' +
        '                <label class="profile-field-label" for="profileUsernameInput">用户名</label>\n' +
        '                <input type="text" id="profileUsernameInput" class="profile-field-input" autocomplete="username" />\n' +
        '            </div>\n' +
        '            <div class="profile-field">\n' +
        '                <label class="profile-field-label" for="profileEmailInput">邮箱</label>\n' +
        '                <input type="email" id="profileEmailInput" class="profile-field-input" autocomplete="email" />\n' +
        '            </div>\n' +
        '            <div class="profile-field">\n' +
        '                <label class="profile-field-label" for="profilePasswordInput">原密码</label>\n' +
        '                <div class="profile-password-wrap">\n' +
        '                    <input\n' +
        '                        type="password"\n' +
        '                        id="profilePasswordInput"\n' +
        '                        class="profile-field-input profile-field-input--readonly"\n' +
        '                        readonly\n' +
        '                        autocomplete="off"\n' +
        '                        autocorrect="off"\n' +
        '                        autocapitalize="off"\n' +
        '                        spellcheck="false"\n' +
        '                        aria-readonly="true"\n' +
        '                        aria-label="原密码（不可修改）"\n' +
        '                        data-form-type="other"\n' +
        '                    />\n' +
        '                    <button\n' +
        '                        type="button"\n' +
        '                        class="profile-password-toggle"\n' +
        '                        id="profilePasswordToggleBtn"\n' +
        '                        aria-label="显示密码"\n' +
        '                        aria-pressed="false"\n' +
        '                        title="显示/隐藏密码"\n' +
        '                    >\n' +
        '                        <svg class="profile-password-icon-hide" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n' +
        '                            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>\n' +
        '                            <circle cx="12" cy="12" r="3"/>\n' +
        '                        </svg>\n' +
        '                        <svg class="profile-password-icon-show" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" hidden>\n' +
        '                            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94"/>\n' +
        '                            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19"/>\n' +
        '                            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>\n' +
        '                            <line x1="1" y1="1" x2="23" y2="23"/>\n' +
        '                        </svg>\n' +
        '                    </button>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '            <div class="profile-field">\n' +
        '                <label class="profile-field-label" for="profileNewPasswordInput">新密码</label>\n' +
        '                <div class="profile-password-wrap">\n' +
        '                    <input\n' +
        '                        type="password"\n' +
        '                        id="profileNewPasswordInput"\n' +
        '                        class="profile-field-input"\n' +
        '                        autocomplete="new-password"\n' +
        '                        autocorrect="off"\n' +
        '                        autocapitalize="off"\n' +
        '                        spellcheck="false"\n' +
        '                        aria-label="新密码"\n' +
        '                        data-form-type="other"\n' +
        '                    />\n' +
        '                    <button\n' +
        '                        type="button"\n' +
        '                        class="profile-password-toggle"\n' +
        '                        id="profileNewPasswordToggleBtn"\n' +
        '                        aria-label="显示密码"\n' +
        '                        aria-pressed="false"\n' +
        '                        title="显示/隐藏密码"\n' +
        '                    >\n' +
        '                        <svg class="profile-password-icon-hide" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n' +
        '                            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>\n' +
        '                            <circle cx="12" cy="12" r="3"/>\n' +
        '                        </svg>\n' +
        '                        <svg class="profile-password-icon-show" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" hidden>\n' +
        '                            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94"/>\n' +
        '                            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19"/>\n' +
        '                            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>\n' +
        '                            <line x1="1" y1="1" x2="23" y2="23"/>\n' +
        '                        </svg>\n' +
        '                    </button>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '            <div class="profile-modal-actions">\n' +
        '                <button type="button" class="profile-save-btn" id="profileSaveBtn">保存</button>\n' +
        '            </div>\n' +
        '        </div>\n' +
        '        <div id="profileAltPanel" class="profile-mode-panel" hidden>\n' +
        '            <div class="profile-alt-head">\n' +
        '                <h3 class="profile-alt-title">备选头像</h3>\n' +
        '            </div>\n' +
        '            <div class="profile-alt-inputs">\n' +
        '                <div class="profile-field" style="margin-top: 0;">\n' +
        '                    <label class="profile-field-label" for="profileAltTextZhInput">中文（汉字与数字，最多 3 个）</label>\n' +
        '                    <input\n' +
        '                        type="text"\n' +
        '                        id="profileAltTextZhInput"\n' +
        '                        class="profile-field-input"\n' +
        '                        maxlength="3"\n' +
        '                        placeholder="例如：王 / 小王 / 王1"\n' +
        '                        autocomplete="off"\n' +
        '                    />\n' +
        '                </div>\n' +
        '                <div class="profile-field" style="margin-top: 0;">\n' +
        '                    <label class="profile-field-label" for="profileAltTextEnInput">英文（字母与数字，最多 3 个）</label>\n' +
        '                    <input\n' +
        '                        type="text"\n' +
        '                        id="profileAltTextEnInput"\n' +
        '                        class="profile-field-input"\n' +
        '                        maxlength="3"\n' +
        '                        placeholder="例如：A / AB / A1"\n' +
        '                        autocomplete="off"\n' +
        '                    />\n' +
        '                </div>\n' +
        '            </div>\n' +
        '            <div id="profileAltGrid" class="profile-alt-grid" aria-label="备选头像列表"></div>\n' +
        '            <div class="profile-modal-actions">\n' +
        '                <button type="button" class="profile-save-btn" id="profileAltApplyBtn">应用到头像</button>\n' +
        '            </div>\n' +
        '        </div>\n' +
        '    </div>\n' +
        '</div>';
        document.body.appendChild(container.firstElementChild);
    }

    // ================================================================
    // 3. 初始化逻辑
    // ================================================================
    var profileInited = false;
    function initProfile() {
        if (profileInited) return;
        if (!document.getElementById('profileModalOverlay')) return;
        profileInited = true;
        var profileModalOverlay = document.getElementById('profileModalOverlay');
        var profileModalCloseBtn = document.getElementById('profileModalCloseBtn');
        var profileMainPanel = document.getElementById('profileMainPanel');
        var profileAltPanel = document.getElementById('profileAltPanel');
        var profileAvatarBtn = document.getElementById('profileAvatarBtn');
        var profileAvatarSourceMenu = document.getElementById('profileAvatarSourceMenu');
        var profileAvatarFileCamera = document.getElementById('profileAvatarFileCamera');
        var profileAvatarFileGallery = document.getElementById('profileAvatarFileGallery');
        var profileAvatarImg = document.getElementById('profileAvatarImg');
        var profileAvatarInitials = document.getElementById('profileAvatarInitials');
        var profilePhoneInput = document.getElementById('profilePhoneInput');
        var profileUsernameInput = document.getElementById('profileUsernameInput');
        var profileEmailInput = document.getElementById('profileEmailInput');
        var profilePasswordInput = document.getElementById('profilePasswordInput');
        var profilePasswordToggleBtn = document.getElementById('profilePasswordToggleBtn');
        var profileNewPasswordInput = document.getElementById('profileNewPasswordInput');
        var profileNewPasswordToggleBtn = document.getElementById('profileNewPasswordToggleBtn');
        bindPasswordHalfwidthInput(profileNewPasswordInput);
        var profileSaveBtn = document.getElementById('profileSaveBtn');
        var profileAltApplyBtn = document.getElementById('profileAltApplyBtn');
        var profileAltCancelBtn = document.getElementById('profileAltCancelBtn');
        var profileAltTextZhInput = document.getElementById('profileAltTextZhInput');
        var profileAltTextEnInput = document.getElementById('profileAltTextEnInput');
        var profileAltGrid = document.getElementById('profileAltGrid');
        var profileModalBodyOverflowPrev = '';
        var profileModalMode = 'main';
        var profileAltActiveChoice = null;
        var profileOriginalPassword = '';
        /** 原密码不可明文时用占位星号展示（如仅存哈希） */
        var PROFILE_PWD_MASK_PLACEHOLDER = '********';

        function setPasswordFieldVisible(inputEl, toggleBtn, visible) {
            if (!inputEl || !toggleBtn) return;
            var show = !!visible;
            inputEl.type = show ? 'text' : 'password';
            toggleBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
            toggleBtn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
            var iconHide = toggleBtn.querySelector('.profile-password-icon-hide');
            var iconShow = toggleBtn.querySelector('.profile-password-icon-show');
            if (iconHide) {
                if (show) iconHide.setAttribute('hidden', '');
                else iconHide.removeAttribute('hidden');
            }
            if (iconShow) {
                if (show) iconShow.removeAttribute('hidden');
                else iconShow.setAttribute('hidden', '');
            }
        }

        function setProfilePasswordVisible(visible) {
            setPasswordFieldVisible(
                profilePasswordInput,
                profilePasswordToggleBtn,
                visible
            );
        }

        function setProfileNewPasswordVisible(visible) {
            setPasswordFieldVisible(
                profileNewPasswordInput,
                profileNewPasswordToggleBtn,
                visible
            );
        }

        function fillProfileOriginalPasswordField(rawPwd, extraHasPassword) {
            var raw = rawPwd != null ? String(rawPwd) : '';
            var plain = normalizeStoredPlainPasswordForProfile(raw);
            profileOriginalPassword = plain;
            if (!profilePasswordInput) return;
            setProfilePasswordVisible(false);
            if (plain) {
                profilePasswordInput.value = plain;
                profilePasswordInput.dataset.revealable = '1';
                profilePasswordInput.dataset.maskedOnly = '0';
                return;
            }
            // 仅有哈希/无明文：仍显示一串 *，小眼睛切换也仍是 *
            var hasPwd =
                !!extraHasPassword ||
                (raw && (raw.indexOf('$') === 0 || raw.length > 80));
            if (hasPwd) {
                profilePasswordInput.value = PROFILE_PWD_MASK_PLACEHOLDER;
                profilePasswordInput.dataset.revealable = '0';
                profilePasswordInput.dataset.maskedOnly = '1';
            } else {
                profilePasswordInput.value = '';
                profilePasswordInput.dataset.revealable = '0';
                profilePasswordInput.dataset.maskedOnly = '0';
            }
        }

        if (profilePasswordToggleBtn) {
            profilePasswordToggleBtn.addEventListener('click', function () {
                if (!profilePasswordInput) return;
                setProfilePasswordVisible(profilePasswordInput.type !== 'text');
            });
        }
        if (profileNewPasswordToggleBtn) {
            profileNewPasswordToggleBtn.addEventListener('click', function () {
                if (!profileNewPasswordInput) return;
                setProfileNewPasswordVisible(profileNewPasswordInput.type !== 'text');
            });
        }

        var profileAvatarPendingDataUrl = null;
        /** 为 true 时保存成功后删除本地自定义头像，仅保留字母头像（「备选」） */
        var profileAvatarClearStoredOnSave = false;
        var profileAvatarSourceMenuDocHandler = null;
        var profileAvatarSourceMenuKeyHandler = null;

        var PROFILE_ALT_PRESETS = [
            { id: 'round-blue',   shape: 'round',  bg: '#2d5be3', fg: '#ffffff', label: '圆形-蓝',   is_bg: 1 },
            { id: 'square-blue',  shape: 'square', bg: '#2d5be3', fg: '#ffffff', label: '方形-蓝',   is_bg: 1 },
            { id: 'round-dark',   shape: 'round',  bg: '#3f3f46', fg: '#ffffff', label: '圆形-深灰', is_bg: 1 },
            { id: 'square-dark',  shape: 'square', bg: '#3f3f46', fg: '#ffffff', label: '方形-深灰', is_bg: 1 },
            { id: 'round-green',  shape: 'round',  bg: '#1f9d6f', fg: '#ffffff', label: '圆形-绿',   is_bg: 1 },
            { id: 'square-green', shape: 'square', bg: '#1f9d6f', fg: '#ffffff', label: '方形-绿',   is_bg: 1 },
            { id: 'round-warm',   shape: 'round',  bg: '#b65f34', fg: '#ffffff', label: '圆形-暖棕', is_bg: 1 },
            { id: 'square-warm',  shape: 'square', bg: '#b65f34', fg: '#ffffff', label: '方形-暖棕', is_bg: 1 }
        ];
        /** 每行 4 格：圆中文、圆英文、方中文、方英文 — 同一行用同一色板 */
        var PROFILE_ALT_THEME_ROWS = [
            { id: 't0', label: '蓝色系',   roundIdx: 0, squareIdx: 1 },
            { id: 't1', label: '深灰色系', roundIdx: 2, squareIdx: 3 },
            { id: 't2', label: '绿色系',   roundIdx: 4, squareIdx: 5 },
            { id: 't3', label: '暖棕色系', roundIdx: 6, squareIdx: 7 }
        ];
        var profileAltImgPromiseCache = {};

        function profilePresetCanOverlayText(preset) {
            if (!preset || typeof preset !== 'object') return false;
            var raw = preset.is_bg;
            if (raw == null || raw === '') return true;
            var n = Number(raw);
            return !Number.isNaN(n) && n === 1;
        }

        function profileModalLockBodyScroll() {
            profileModalBodyOverflowPrev = document.body.style.overflow || '';
            document.body.style.overflow = 'hidden';
        }

        function profileModalUnlockBodyScroll() {
            document.body.style.overflow = profileModalBodyOverflowPrev;
        }

        function profileAvatarFileLooksLikeImage(f) {
            if (!f) return false;
            var t = (f.type || '').toLowerCase();
            if (t.indexOf('image/') === 0) return true;
            return /\.(heic|heif|jpg|jpeg|png|gif|webp|avif|bmp)$/i.test(f.name || '');
        }

        function hideProfileAvatarSourceMenu() {
            if (profileAvatarSourceMenu) {
                profileAvatarSourceMenu.setAttribute('hidden', '');
                profileAvatarSourceMenu.setAttribute('aria-hidden', 'true');
            }
            if (profileAvatarBtn) {
                profileAvatarBtn.setAttribute('aria-expanded', 'false');
            }
            if (typeof profileAvatarSourceMenuDocHandler === 'function') {
                document.removeEventListener('click', profileAvatarSourceMenuDocHandler, true);
                profileAvatarSourceMenuDocHandler = null;
            }
            if (typeof profileAvatarSourceMenuKeyHandler === 'function') {
                document.removeEventListener('keydown', profileAvatarSourceMenuKeyHandler, true);
                profileAvatarSourceMenuKeyHandler = null;
            }
        }

        function showProfileAvatarSourceMenu() {
            if (!profileAvatarSourceMenu || !profileAvatarBtn) {
                return;
            }
            profileAvatarSourceMenu.removeAttribute('hidden');
            profileAvatarSourceMenu.setAttribute('aria-hidden', 'false');
            profileAvatarBtn.setAttribute('aria-expanded', 'true');
            setTimeout(function () {
                profileAvatarSourceMenuDocHandler = function (ev) {
                    if (profileAvatarBtn && profileAvatarBtn.contains(ev.target)) {
                        return;
                    }
                    if (profileAvatarSourceMenu && profileAvatarSourceMenu.contains(ev.target)) {
                        return;
                    }
                    hideProfileAvatarSourceMenu();
                };
                profileAvatarSourceMenuKeyHandler = function (ev) {
                    if (ev.key === 'Escape') {
                        hideProfileAvatarSourceMenu();
                    }
                };
                document.addEventListener('click', profileAvatarSourceMenuDocHandler, true);
                document.addEventListener('keydown', profileAvatarSourceMenuKeyHandler, true);
            }, 0);
        }

        function isProfileAvatarSourceMenuVisible() {
            return !!(profileAvatarSourceMenu && !profileAvatarSourceMenu.hasAttribute('hidden'));
        }

        function profileModalSetMode(mode) {
            profileModalMode = mode === 'alt' ? 'alt' : 'main';
            if (profileModalOverlay) {
                if (profileModalMode === 'alt') {
                    profileModalOverlay.classList.add('is-alt');
                } else {
                    profileModalOverlay.classList.remove('is-alt');
                }
            }
            if (profileMainPanel) {
                if (profileModalMode === 'main') {
                    profileMainPanel.removeAttribute('hidden');
                } else {
                    profileMainPanel.setAttribute('hidden', '');
                }
            }
            if (profileAltPanel) {
                if (profileModalMode === 'alt') {
                    profileAltPanel.removeAttribute('hidden');
                } else {
                    profileAltPanel.setAttribute('hidden', '');
                }
            }
            if (profileModalMode === 'alt' && profileAltTextZhInput) {
                setTimeout(function () {
                    try {
                        profileAltTextZhInput.focus();
                        profileAltTextZhInput.select();
                    } catch (e) {}
                }, 0);
            }
        }

        function profileAltSanitizeZh(raw) {
            // 汉字（CJK 常用区）+ ASCII 数字，至多 3 个字符，按输入顺序截取
            var src = String(raw || '');
            var reCh = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
            var out = '';
            for (var i = 0; i < src.length && out.length < 3; i++) {
                var ch = src.charAt(i);
                if (reCh.test(ch) || /[0-9]/.test(ch)) out += ch;
            }
            return out;
        }

        function profileAltSanitizeEn(raw) {
            // 英文字母（转大写）+ 数字，至多 3 个字符
            var s = String(raw || '');
            var out = '';
            for (var i = 0; i < s.length && out.length < 3; i++) {
                var ch = s.charAt(i);
                if (/[a-zA-Z]/.test(ch)) out += ch.toUpperCase();
                else if (/[0-9]/.test(ch)) out += ch;
            }
            return out;
        }

        /** 根据背景色 hex/rgb 计算相对亮度，返回白色或黑色文字颜色 */
        function profilePickTextColorForBg(bg) {
            var s = String(bg || '').trim();
            var r = 128, g = 128, b = 128;
            if (s) {
                var m;
                // hex #RGB / #RRGGBB
                m = s.match(/^#([0-9a-fA-F]{3,6})$/);
                if (m) {
                    var h = m[1];
                    if (h.length === 3) {
                        r = parseInt(h[0] + h[0], 16);
                        g = parseInt(h[1] + h[1], 16);
                        b = parseInt(h[2] + h[2], 16);
                    } else {
                        r = parseInt(h.slice(0, 2), 16);
                        g = parseInt(h.slice(2, 4), 16);
                        b = parseInt(h.slice(4, 6), 16);
                    }
                }
                // rgb(r, g, b) / rgba(r, g, b, ...)
                m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                if (m) {
                    r = parseInt(m[1], 10) || 0;
                    g = parseInt(m[2], 10) || 0;
                    b = parseInt(m[3], 10) || 0;
                }
            }
            // WCAG 相对亮度
            var toLinear = function (c) {
                c = c / 255;
                return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            };
            var L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
            return L > 0.55 ? '#111' : '#fff';
        }

        function buildPresetAvatarDataUrl(preset, text, lang, shapeOverride) {
            var shape = shapeOverride || (preset && preset.shape) || 'square';
            var canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            var ctx = canvas.getContext('2d');
            if (!ctx) return '';
            ctx.clearRect(0, 0, 512, 512);

            if (shape === 'round') {
                ctx.beginPath();
                ctx.arc(256, 256, 248, 0, Math.PI * 2);
                ctx.closePath();
                ctx.fillStyle = preset.bg;
                ctx.fill();
            } else {
                ctx.fillStyle = preset.bg;
                ctx.fillRect(8, 8, 496, 496);
            }

            if (!profilePresetCanOverlayText(preset)) {
                return canvas.toDataURL('image/png');
            }

            ctx.fillStyle = preset.fg || profilePickTextColorForBg(preset.bg);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font =
                lang === 'zh'
                    ? 'bold 190px "PingFang SC","Microsoft YaHei",sans-serif'
                    : 'bold 182px "SF Pro Display","Arial",sans-serif';
            ctx.fillText(text || (lang === 'zh' ? '字' : 'A'), 256, 270);
            return canvas.toDataURL('image/png');
        }

        function profileLoadDataUrlImage(src) {
            if (!src || typeof src !== 'string' || !String(src).trim()) {
                return Promise.reject(new Error('empty image src'));
            }
            if (profileAltImgPromiseCache[src]) {
                return profileAltImgPromiseCache[src];
            }
            profileAltImgPromiseCache[src] = new Promise(function (resolve, reject) {
                var im = new Image();
                im.onload = function () {
                    resolve(im);
                };
                im.onerror = function () {
                    try {
                        delete profileAltImgPromiseCache[src];
                    } catch (e) {}
                    reject(new Error('image load failed'));
                };
                im.src = src;
            });
            return profileAltImgPromiseCache[src];
        }

        function profileDrawCover(ctx, img, dx, dy, dw, dh) {
            var sw = img.naturalWidth || img.width;
            var sh = img.naturalHeight || img.height;
            if (!sw || !sh) {
                return;
            }
            var scale = Math.max(dw / sw, dh / sh);
            var rw = sw * scale;
            var rh = sh * scale;
            var ox = dx + (dw - rw) / 2;
            var oy = dy + (dh - rh) / 2;
            ctx.drawImage(img, ox, oy, rw, rh);
        }

        function buildImageAvatarDataUrl(dataUrl, clipShape, text, lang, isBg) {
            if (!dataUrl || typeof dataUrl !== 'string' || !String(dataUrl).trim()) {
                return Promise.resolve('');
            }
            return profileLoadDataUrlImage(dataUrl)
                .then(function (img) {
                    var canvas = document.createElement('canvas');
                    canvas.width = 512;
                    canvas.height = 512;
                    var ctx = canvas.getContext('2d');
                    if (!ctx) return '';
                    var pad = 8;
                    var inner = 512 - pad * 2;
                    ctx.save();
                    if (clipShape === 'round') {
                        ctx.beginPath();
                        ctx.arc(256, 256, 248, 0, Math.PI * 2);
                        ctx.closePath();
                        ctx.clip();
                    } else {
                        ctx.beginPath();
                        ctx.rect(pad, pad, inner, inner);
                        ctx.closePath();
                        ctx.clip();
                    }
                    ctx.fillStyle = '#1a1a1a';
                    ctx.fillRect(0, 0, 512, 512);
                    profileDrawCover(ctx, img, pad, pad, inner, inner);
                    ctx.restore();
                    if (profilePresetCanOverlayText({ is_bg: isBg })) {
                        var t =
                            text != null && String(text) !== ''
                                ? String(text)
                                : lang === 'zh'
                                  ? '字'
                                  : 'A';
                        // 采样画布中心区域亮度，浅色背景用深色文字
                        var sampleW = 40, sampleH = 40;
                        var sx = (512 - sampleW) >> 1, sy = (512 - sampleH) >> 1;
                        var imgData;
                        try { imgData = ctx.getImageData(sx, sy, sampleW, sampleH); } catch (e) {}
                        var useDark = false;
                        if (imgData && imgData.data && imgData.data.length >= 4) {
                            var totalL = 0, count = 0;
                            var d = imgData.data;
                            for (var pi = 0; pi < d.length; pi += 4) {
                                totalL += 0.2126 * (d[pi] / 255) + 0.7152 * (d[pi + 1] / 255) + 0.0722 * (d[pi + 2] / 255);
                                count++;
                            }
                            useDark = count > 0 && (totalL / count) > 0.5;
                        }
                        ctx.fillStyle = useDark ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.96)';
                        ctx.strokeStyle = useDark ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.42)';
                        ctx.lineWidth = 10;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.font =
                            lang === 'zh'
                                ? 'bold 190px "PingFang SC","Microsoft YaHei",sans-serif'
                                : 'bold 182px "SF Pro Display","Arial",sans-serif';
                        ctx.strokeText(t, 256, 270);
                        ctx.fillText(t, 256, 270);
                    }
                    return canvas.toDataURL('image/png');
                })
                .catch(function () {
                    return '';
                });
        }

        function profileBuildAltRowSpecs() {
            var rows = [];
            for (var ti = 0; ti < PROFILE_ALT_THEME_ROWS.length; ti++) {
                var tr = PROFILE_ALT_THEME_ROWS[ti];
                rows.push({
                    id: tr.id,
                    label: tr.label,
                    round: { kind: 'color', preset: PROFILE_ALT_PRESETS[tr.roundIdx] },
                    square: { kind: 'color', preset: PROFILE_ALT_PRESETS[tr.squareIdx] }
                });
            }
            function sortSavedEntries(list) {
                var arr = (list || []).map(avatarSavedNormalizeEntry).filter(Boolean);
                arr.sort(function (a, b) {
                    var ba = b.is_bg === 1 ? 1 : 0;
                    var aa = a.is_bg === 1 ? 1 : 0;
                    return ba - aa;
                });
                return arr;
            }
            sortSavedEntries(avatarSavedRoundList).forEach(function (item, i) {
                rows.push({
                    id: 'saved-r-' + i,
                    label: '头像管理·圆 #' + (i + 1),
                    round: { kind: 'image', dataUrl: item.dataUrl, is_bg: item.is_bg },
                    square: { kind: 'image', dataUrl: item.dataUrl, is_bg: item.is_bg }
                });
            });
            sortSavedEntries(avatarSavedSquareList).forEach(function (item, i) {
                rows.push({
                    id: 'saved-s-' + i,
                    label: '头像管理·方 #' + (i + 1),
                    round: { kind: 'image', dataUrl: item.dataUrl, is_bg: item.is_bg },
                    square: { kind: 'image', dataUrl: item.dataUrl, is_bg: item.is_bg }
                });
            });
            return rows;
        }

        function profileAltBuildCellDataUrl(source, text, lang, forceShape) {
            if (!source || source.kind === 'color') {
                var pr = source && source.preset;
                if (!pr) return Promise.resolve('');
                return Promise.resolve(buildPresetAvatarDataUrl(pr, text, lang, forceShape));
            }
            if (source.kind === 'image') {
                return buildImageAvatarDataUrl(
                    source.dataUrl,
                    forceShape,
                    text,
                    lang,
                    source.is_bg
                ).catch(function () {
                    return '';
                });
            }
            return Promise.resolve('');
        }

        function profileAltSetActiveChoice(choice) {
            profileAltActiveChoice = choice || null;
            if (!profileAltGrid) return;
            var options = profileAltGrid.querySelectorAll('.profile-alt-option');
            for (var i = 0; i < options.length; i++) {
                var opt = options[i];
                var on =
                    !!choice &&
                    opt.getAttribute('data-row-id') === choice.rowId &&
                    opt.getAttribute('data-variant') === choice.variant;
                opt.classList.toggle('is-active', on);
            }
        }

        function renderProfileAltGrid() {
            if (!profileAltGrid) return Promise.resolve();
            var zh = profileAltSanitizeZh(profileAltTextZhInput ? profileAltTextZhInput.value : '');
            var en = profileAltSanitizeEn(profileAltTextEnInput ? profileAltTextEnInput.value : '');
            if (profileAltTextZhInput && profileAltTextZhInput.value !== zh) profileAltTextZhInput.value = zh;
            if (profileAltTextEnInput && profileAltTextEnInput.value !== en) profileAltTextEnInput.value = en;
            profileAltGrid.innerHTML = '';
            var rowSpecs = profileBuildAltRowSpecs();
            var colDefs = [
                {
                    variant: 'round-zh',
                    shape: 'round',
                    lang: 'zh',
                    text: zh || '字',
                    short: '圆·中',
                    col: 'round'
                },
                {
                    variant: 'round-en',
                    shape: 'round',
                    lang: 'en',
                    text: en || 'A',
                    short: '圆·英',
                    col: 'round'
                },
                {
                    variant: 'square-zh',
                    shape: 'square',
                    lang: 'zh',
                    text: zh || '字',
                    short: '方·中',
                    col: 'square'
                },
                {
                    variant: 'square-en',
                    shape: 'square',
                    lang: 'en',
                    text: en || 'A',
                    short: '方·英',
                    col: 'square'
                }
            ];

            var jobs = rowSpecs.map(function (spec) {
                return Promise.all(
                    colDefs.map(function (cd) {
                        var src = cd.col === 'round' ? spec.round : spec.square;
                        return profileAltBuildCellDataUrl(src, cd.text, cd.lang, cd.shape).then(function (du) {
                            return { spec: spec, cd: cd, dataUrl: du };
                        });
                    })
                );
            });

            return Promise.all(
                jobs.map(function (job) {
                    return job.catch(function () {
                        return [];
                    });
                })
            )
                .then(function (allRows) {
                    if (!profileAltGrid) return;
                    for (var ri = 0; ri < allRows.length; ri++) {
                        var cells = allRows[ri];
                        var spec = rowSpecs[ri];
                        var row = document.createElement('div');
                        row.className = 'profile-alt-row';
                        var title = document.createElement('p');
                        title.className = 'profile-alt-row-title';
                        title.textContent = spec.label;
                        row.appendChild(title);
                        var quad = document.createElement('div');
                        quad.className = 'profile-alt-quad';
                        row.appendChild(quad);
                        for (var ci = 0; ci < cells.length; ci++) {
                            (function (cell) {
                                var cd = cell.cd;
                                var dataUrl = cell.dataUrl || '';
                                var option = document.createElement('button');
                                option.type = 'button';
                                option.className =
                                    'profile-alt-option' + (cd.shape === 'round' ? ' is-round' : '');
                                option.setAttribute('data-row-id', spec.id);
                                option.setAttribute('data-variant', cd.variant);
                                var img = document.createElement('img');
                                img.src = dataUrl;
                                img.alt = spec.label + '-' + cd.short;
                                option.appendChild(img);
                                var lbl = document.createElement('span');
                                lbl.className = 'profile-alt-option-label';
                                lbl.textContent = cd.short + ' ' + cd.text;
                                option.appendChild(lbl);
                                option.addEventListener('click', function () {
                                    profileAltSetActiveChoice({
                                        rowId: spec.id,
                                        variant: cd.variant,
                                        lang: cd.lang,
                                        text: cd.text,
                                        shape: cd.shape,
                                        dataUrl: dataUrl
                                    });
                                });
                                option.addEventListener('dblclick', function () {
                                    profileAltSetActiveChoice({
                                        rowId: spec.id,
                                        variant: cd.variant,
                                        lang: cd.lang,
                                        text: cd.text,
                                        shape: cd.shape,
                                        dataUrl: dataUrl
                                    });
                                    applyProfileAvatarTextPreview(cd.text);
                                    profileModalSetMode('main');
                                });
                                quad.appendChild(option);
                            })(cells[ci]);
                        }
                        profileAltGrid.appendChild(row);
                    }

                    var selOk =
                        profileAltActiveChoice &&
                        profileAltGrid.querySelector(
                            '.profile-alt-option[data-row-id="' +
                                profileAltActiveChoice.rowId +
                                '"][data-variant="' +
                                profileAltActiveChoice.variant +
                                '"]'
                        );
                    if (!selOk && allRows.length && allRows[0].length) {
                        var pick = allRows[0][0];
                        profileAltSetActiveChoice({
                            rowId: pick.spec.id,
                            variant: pick.cd.variant,
                            lang: pick.cd.lang,
                            text: pick.cd.text,
                            shape: pick.cd.shape,
                            dataUrl: pick.dataUrl
                        });
                    } else {
                        profileAltSetActiveChoice(profileAltActiveChoice);
                    }
                })
                .catch(function (e) {
                    console.warn('备选头像渲染失败', e);
                });
        }

        function applyProfileAvatarTextPreview(textInput) {
            var rec = readRegistrationReceipt();
            var nameGuess =
                (textInput != null ? String(textInput).trim() : '') ||
                (profileUsernameInput && profileUsernameInput.value.trim()) ||
                (rec && rec.value && rec.value.name) ||
                '';
            var hasPresetImage = !!(profileAltActiveChoice && profileAltActiveChoice.dataUrl);
            profileAvatarClearStoredOnSave = !hasPresetImage;
            profileAvatarPendingDataUrl = hasPresetImage ? profileAltActiveChoice.dataUrl : null;
            if (profileAvatarImg) {
                profileAvatarImg.onerror = null;
                if (hasPresetImage) {
                    profileAvatarImg.src = profileAltActiveChoice.dataUrl;
                    profileAvatarImg.removeAttribute('hidden');
                } else {
                    profileAvatarImg.removeAttribute('src');
                    profileAvatarImg.setAttribute('hidden', '');
                }
            }
            if (profileAvatarInitials) {
                if (hasPresetImage) {
                    profileAvatarInitials.setAttribute('hidden', '');
                } else {
                    profileAvatarInitials.removeAttribute('hidden');
                    applyPinyinInitialsToEl(nameGuess, profileAvatarInitials);
                }
            }
        }

        function handleProfileAvatarFileInputChange(inputEl) {
            if (!inputEl) {
                return;
            }
            var f = inputEl.files && inputEl.files[0];
            if (!f || !profileAvatarFileLooksLikeImage(f)) {
                inputEl.value = '';
                return;
            }
            profileAvatarClearStoredOnSave = false;
            var reader = new FileReader();
            reader.onload = function () {
                var url = reader.result;
                profileAvatarPendingDataUrl = url;
                if (profileAvatarImg && profileAvatarInitials) {
                    profileAvatarImg.onerror = function () {
                        profileAvatarImg.onerror = null;
                        profileAvatarPendingDataUrl = null;
                        profileAvatarImg.setAttribute('hidden', '');
                        profileAvatarInitials.removeAttribute('hidden');
                        alert(
                            '当前环境无法显示该图片（常见于安卓上的 HEIC）。请在相册里选「存储为 JPEG」或选用 JPG/PNG/WebP。'
                        );
                    };
                    profileAvatarImg.onload = function () {
                        profileAvatarImg.onload = null;
                        profileAvatarImg.onerror = null;
                    };
                    profileAvatarImg.src = url;
                    profileAvatarImg.removeAttribute('hidden');
                    profileAvatarInitials.setAttribute('hidden', '');
                }
            };
            reader.readAsDataURL(f);
            inputEl.value = '';
        }

        function closeProfileModal() {
            hideProfileAvatarSourceMenu();
            profileModalSetMode('main');
            profileAvatarPendingDataUrl = null;
            profileModalUnlockBodyScroll();
            if (profileAvatarImg) {
                profileAvatarImg.onerror = null;
            }
            if (profileModalOverlay) {
                profileModalOverlay.classList.remove('show');
                profileModalOverlay.setAttribute('aria-hidden', 'true');
            }
        }

        function openProfileModal() {
            var phoneHint = "";
            try {
                phoneHint =
                    (typeof window.getCurrentUserPhone === "function" &&
                        window.getCurrentUserPhone()) ||
                    String(window.__currentUserPhone || "");
            } catch (ePh) {
                phoneHint = "";
            }
            var rec = readRegistrationReceipt();
            if (!isRegistrationReceiptActive(rec)) {
                // 有全局手机号时仍尝试按 leng_user 打开；否则提示先登录
                if (!phoneHint) {
                    alert('请先登录，再使用个人资料。');
                    return;
                }
                if (!rec) {
                    alert('请先登录，再使用个人资料。');
                    return;
                }
            }
            var phone =
                (phoneHint && String(phoneHint).replace(/\D/g, "")) ||
                (rec.keyStr && rec.keyStr.indexOf('phone:') === 0 ? rec.keyStr.slice(6) : '');
            if (phone && typeof window.setCurrentUserPhone === "function") {
                window.setCurrentUserPhone(phone);
            }
            var v = rec.value || {};
            if (profilePhoneInput) profilePhoneInput.value = phone || '—';
            if (profileUsernameInput) profileUsernameInput.value = v.name || '';
            if (profileEmailInput) profileEmailInput.value = v.email || '';
            var localPwd =
                (v && v.pwd != null ? String(v.pwd) : '') ||
                (function () {
                    try {
                        var u = window.__LENG_USER;
                        if (u && u.password) return String(u.password);
                        if (u && u.user_data && u.user_data.pwd) return String(u.user_data.pwd);
                    } catch (eLoc) {}
                    return '';
                })();
            fillProfileOriginalPasswordField(
                localPwd,
                !!(v && (v.pwd_hash || v.password_hash))
            );
            if (profileNewPasswordInput) {
                profileNewPasswordInput.value = '';
                setProfileNewPasswordVisible(false);
            }
            // 扫码/魔法链接登录时常未写入明文密码：打开资料时从 check-user 补拉 KV 中的 pwd
            if (
                phone &&
                !normalizeStoredPlainPasswordForProfile(localPwd) &&
                profilePasswordInput
            ) {
                fetch('/api/check-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    cache: 'no-store',
                    body: JSON.stringify({ phone: phone })
                })
                    .then(function (r) {
                        return r.json();
                    })
                    .then(function (j) {
                        if (!j || !j.success || !j.phone_exists) return;
                        var remotePwd =
                            (j.user_data && j.user_data.pwd != null
                                ? String(j.user_data.pwd)
                                : '') || '';
                        fillProfileOriginalPasswordField(
                            remotePwd,
                            !!(
                                remotePwd ||
                                (j.password_hash_format &&
                                    j.password_hash_format !== 'none')
                            )
                        );
                        if (remotePwd && typeof writeRegistrationReceipt === 'function') {
                            try {
                                var rec2 = readRegistrationReceipt();
                                if (rec2 && rec2.value) {
                                    rec2.value.pwd = remotePwd;
                                    writeRegistrationReceipt(rec2);
                                }
                            } catch (eW) {}
                        }
                    })
                    .catch(function () {});
            }
            var stored =
                getReceiptAvatarUrl(rec) ||
                readStoredProfileAvatar(phone, getCurrentAvatarOwnerId()) ||
                getReceiptAvatarDataUrl(rec);
            hideProfileAvatarSourceMenu();
            profileModalSetMode('main');
            profileAvatarClearStoredOnSave = false;
            profileAvatarPendingDataUrl = null;
            if (stored && profileAvatarImg && profileAvatarInitials) {
                profileAvatarImg.onerror = function () {
                    profileAvatarImg.onerror = null;
                    profileAvatarImg.removeAttribute('src');
                    profileAvatarImg.setAttribute('hidden', '');
                    profileAvatarInitials.removeAttribute('hidden');
                    applyPinyinInitialsToEl(v.name || '', profileAvatarInitials);
                };
                profileAvatarImg.src = stored;
                profileAvatarImg.removeAttribute('hidden');
                profileAvatarInitials.setAttribute('hidden', '');
            } else if (profileAvatarImg && profileAvatarInitials) {
                profileAvatarImg.onerror = null;
                profileAvatarImg.removeAttribute('src');
                profileAvatarImg.setAttribute('hidden', '');
                profileAvatarInitials.removeAttribute('hidden');
                applyPinyinInitialsToEl(v.name || '', profileAvatarInitials);
            }
            if (profileModalOverlay) {
                profileModalLockBodyScroll();
                profileModalOverlay.classList.add('show');
                profileModalOverlay.setAttribute('aria-hidden', 'false');
            }
        }

        // ---- 事件绑定 ----
        if (profileModalCloseBtn) {
            profileModalCloseBtn.addEventListener('click', function () {
                if (profileModalMode === 'alt') {
                    profileModalSetMode('main');
                    return;
                }
                closeProfileModal();
            });
        }
        if (profileModalOverlay) {
            profileModalOverlay.addEventListener('click', function (e) {
                if (e.target === profileModalOverlay) closeProfileModal();
            });
        }
        if (profileAvatarBtn) {
            profileAvatarBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (isProfileAvatarSourceMenuVisible()) {
                    hideProfileAvatarSourceMenu();
                } else {
                    showProfileAvatarSourceMenu();
                }
            });
        }
        if (profileAvatarSourceMenu) {
            profileAvatarSourceMenu.addEventListener('click', function (ev) {
                ev.stopPropagation();
            });
            var avatarSourceBtns = profileAvatarSourceMenu.querySelectorAll('[data-avatar-source]');
            for (var bi = 0; bi < avatarSourceBtns.length; bi++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var src = btn.getAttribute('data-avatar-source');
                        hideProfileAvatarSourceMenu();
                        if (src === 'gallery') {
                            if (profileAvatarFileGallery) {
                                profileAvatarFileGallery.click();
                            }
                        } else if (src === 'camera') {
                            if (profileAvatarFileCamera) {
                                profileAvatarFileCamera.click();
                            }
                        } else if (src === 'alternate') {
                            profileModalSetMode('alt');
                            avatarSavedLoad();
                            console.log('[alt] avatarSavedLoad done, RR=', avatarSavedRoundList ? avatarSavedRoundList.length : 0, 'SS=', avatarSavedSquareList ? avatarSavedSquareList.length : 0);
                            avatarSavedLoadRemotePresets().then(function (ok) {
                                console.log('[alt] remotePresets ok=', ok, 'RR=', avatarSavedRoundList ? avatarSavedRoundList.length : 0, 'SS=', avatarSavedSquareList ? avatarSavedSquareList.length : 0);
                                renderProfileAltGrid();
                            }).catch(function (e) {
                                console.error('[alt] remotePresets error:', e);
                                renderProfileAltGrid();
                            });
                        }
                    });
                })(avatarSourceBtns[bi]);
            }
        }
        if (profileAltTextZhInput) {
            profileAltTextZhInput.addEventListener('input', function () {
                renderProfileAltGrid();
            });
        }
        if (profileAltTextEnInput) {
            profileAltTextEnInput.addEventListener('input', function () {
                renderProfileAltGrid();
            });
        }
        if (profileAltCancelBtn) {
            profileAltCancelBtn.addEventListener('click', function () {
                profileModalSetMode('main');
            });
        }
        if (profileAltApplyBtn) {
            profileAltApplyBtn.addEventListener('click', function () {
                var zh = profileAltSanitizeZh(profileAltTextZhInput ? profileAltTextZhInput.value : '');
                var en = profileAltSanitizeEn(profileAltTextEnInput ? profileAltTextEnInput.value : '');
                if (!zh && !en) {
                    alert('请至少输入中文或英文其中一项。');
                    return;
                }
                renderProfileAltGrid().then(function () {
                    var txt =
                        (profileAltActiveChoice && profileAltActiveChoice.text) ||
                        zh ||
                        en ||
                        '';
                    applyProfileAvatarTextPreview(txt);
                    profileModalSetMode('main');
                });
            });
        }
        if (profileAvatarFileGallery) {
            profileAvatarFileGallery.addEventListener('change', function () {
                handleProfileAvatarFileInputChange(profileAvatarFileGallery);
            });
        }
        if (profileAvatarFileCamera) {
            profileAvatarFileCamera.addEventListener('change', function () {
                handleProfileAvatarFileInputChange(profileAvatarFileCamera);
            });
        }
        if (profileSaveBtn) {
            profileSaveBtn.addEventListener('click', function () {
                var rec = readRegistrationReceipt();
                if (!rec || !rec.keyStr || !rec.value) {
                    alert('无本地收据数据。');
                    return;
                }
                var phone =
                    rec.keyStr && rec.keyStr.indexOf('phone:') === 0 ? rec.keyStr.slice(6) : '';
                var nameNew = profileUsernameInput ? profileUsernameInput.value.trim() : '';
                var emailNew = profileEmailInput ? profileEmailInput.value.trim() : '';
                var pwdNewTrim = profileNewPasswordInput
                    ? String(profileNewPasswordInput.value || '').trim()
                    : '';
                if (!nameNew) {
                    alert('用户名不能为空。');
                    return;
                }
                if (!emailNew) {
                    alert('邮箱不能为空');
                    return;
                }
                var nextVal = Object.assign({}, rec.value, {
                    name: nameNew,
                    email: emailNew
                });
                // 未填写新密码时不要把空串写回 KV（会冲掉服务端密码哈希）
                if (pwdNewTrim) {
                    nextVal.pwd = pwdNewTrim;
                } else {
                    delete nextVal.pwd;
                }
                var ownerIdForAvatar = getCurrentAvatarOwnerId() || (phone ? ('phone-' + phone) : '');
                if (profileAvatarClearStoredOnSave) {
                    delete nextVal.avatar_url;
                    delete nextVal.avatar_r2_key;
                    delete nextVal.avatar_data_url;
                } else if (profileAvatarPendingDataUrl) {
                    // 本站暂无 /api/avatar-save：头像以 data URL 写入 KV
                    nextVal.avatar_data_url = String(profileAvatarPendingDataUrl);
                }
                /** 不传收据里的 metadata：避免旧收据/默认模板覆盖服务端已调整的权限位；服务端用浅合并保留原 metadata */
                var metaForSave = {};
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                var updateProfileUrl =
                    window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                        ? '/api/update-kv-profile'
                        : (apiBase || '') + '/api/update-kv-profile';
                var nextRec = Object.assign({}, rec, {
                    value: nextVal,
                    metadata: metaForSave,
                    updatedAt: Date.now()
                });
                var btn = profileSaveBtn;
                var prevText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '保存中…';
                if (ENABLE_AVATAR_DEBUG_TO_DOCK) {
                console.info(
                    dbgTagged(DBG_A0002_2, '[avatar] profile save start'),
                    {
                        phone: phone,
                        has_pending_avatar: !!profileAvatarPendingDataUrl,
                        clear_avatar: !!profileAvatarClearStoredOnSave,
                        updateKvProfile_url: updateProfileUrl
                    }
                );
                }
                dbgEmitNetworkUpdateKvHint(
                    'FETCH',
                    updateProfileUrl,
                    '名称多为路径末段 update-kv-profile；域名与页面同源'
                );
                var profileUpdatePromise = fetch(updateProfileUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        key: rec.keyStr,
                        value: nextVal,
                        metadata: metaForSave
                    })
                }).then(function (r) {
                    return r.text().then(function (text) {
                        var j = null;
                        if (text) {
                            try {
                                j = JSON.parse(text);
                            } catch (e) {
                                console.error('[update-kv-profile] 响应非 JSON', text.slice(0, 500));
                            }
                        }
                        return {
                            ok: r.ok,
                            j: j,
                            status: r.status,
                            textSnippet: text ? String(text).slice(0, 400) : ''
                        };
                    });
                });
                profileUpdatePromise
                    .then(function (x) {
                        btn.disabled = false;
                        btn.textContent = prevText;
                        if (x.j && x.j.success === true) {
                            var dbgClearAvatar = !!profileAvatarClearStoredOnSave;
                            var dbgHadPendingAvatar = !!profileAvatarPendingDataUrl;
                            var savedVal =
                                x.j.value != null && typeof x.j.value === 'object' ? x.j.value : nextVal;
                            if (!dbgClearAvatar) {
                                savedVal = mergeAvatarHttpsFromDiagnostics(savedVal, (x.j && x.j.avatar_diagnostics) || null);
                            }
                            var savedMeta =
                                x.j.metadata != null && typeof x.j.metadata === 'object'
                                    ? x.j.metadata
                                    : rec.metadata && typeof rec.metadata === 'object'
                                      ? rec.metadata
                                      : {};
                            writeRegistrationReceipt({
                                version: rec.version != null ? rec.version : 1,
                                keyStr: rec.keyStr,
                                value: savedVal,
                                metadata: savedMeta,
                                pendingKvSave: false,
                                kvSaveOk: true,
                                updatedAt: Date.now()
                            });
                            if (profileAvatarClearStoredOnSave) {
                                clearStoredProfileAvatar(phone, ownerIdForAvatar);
                                profileAvatarClearStoredOnSave = false;
                            } else if (profileAvatarPendingDataUrl) {
                                var localAvatarValue =
                                    (savedVal && savedVal.avatar_url ? String(savedVal.avatar_url) : '') ||
                                    String(profileAvatarPendingDataUrl || '');
                                writeStoredProfileAvatar(
                                    phone,
                                    ownerIdForAvatar,
                                    localAvatarValue
                                );
                                profileAvatarPendingDataUrl = null;
                            }
                            if (window.userListModal && typeof window.userListModal.syncProfileChange === 'function') {
                                window.userListModal.syncProfileChange(
                                    rec.keyStr,
                                    nameNew,
                                    pwdNewTrim || profileOriginalPassword || ''
                                );
                            }
                            if (ENABLE_AVATAR_DEBUG_TO_DOCK) {
                            console.info(
                                dbgTagged(DBG_A0002_2, '[avatar] profile save success'),
                                {
                                    phone: phone,
                                    has_saved_avatar: !!(
                                        savedVal &&
                                        (savedVal.avatar_url || savedVal.avatar_data_url)
                                    ),
                                    owner_id: ownerIdForAvatar || '',
                                    kv_avatar_url: (savedVal && savedVal.avatar_url) || '',
                                    kv_avatar_r2_key: (savedVal && savedVal.avatar_r2_key) || ''
                                }
                            );
                            try {
                                var adAfter = (x.j && x.j.avatar_diagnostics) || null;
                                console.info(
                                    '[A0002-2] [avatar] profile save · KV 与 D1 探针快照',
                                    adAfter
                                        ? {
                                              kv_avatar_url_stored: String(
                                                  adAfter.kv_avatar_url_stored || ''
                                              ).slice(0, 200),
                                              kv_avatar_r2_key_stored: String(
                                                  adAfter.kv_avatar_r2_key_stored || ''
                                              ).slice(0, 160),
                                              d1_latest_r2_key: String(adAfter.d1_latest_r2_key || ''),
                                              d1_customs_row_exists: !!adAfter.d1_customs_row_exists,
                                              deduced_media_url: String(
                                                  adAfter.deduced_media_url_from_d1_key || ''
                                              ).slice(0, 180)
                                          }
                                        : {
                                              note: '响应无 avatar_diagnostics，仅见上方 kv_* 回写'
                                          }
                                );
                            } catch (_ePs) {}
                            }
                            if (ENABLE_AVATAR_DEBUG_TO_DOCK) {
                            (function pushProfileCloseDebugDock() {
                                try {
                                    /* 不经 __L_ENG_debugDockPrint 早退：与 [avatar] 相同，再走 console.info → 钩子进面板 */
                                    function profileSaveDockMirror(msgInner) {
                                        var full = dbgTagged(DBG_A0002_2, String(msgInner == null ? '' : msgInner));
                                        var usedDock = false;
                                        try {
                                            if (typeof window.__L_ENG_debugDockPrint === 'function') {
                                                window.__L_ENG_debugDockPrint('info', full);
                                                usedDock = true;
                                            }
                                        } catch (_eDp) {}
                                        if (!usedDock) {
                                            try {
                                                console.info(full);
                                            } catch (_eCi) {}
                                        }
                                    }
                                    var flowLabel = '仅更新 KV（无新头像上传）';
                                    if (dbgClearAvatar) {
                                        flowLabel = '清空头像字段后保存';
                                    } else if (dbgHadPendingAvatar) {
                                        flowLabel = '先发 avatar-save · 再 update-kv-profile';
                                    }
                                    var truncate = function (s, n) {
                                        var t = s == null ? '' : String(s);
                                        var m = typeof n === 'number' ? n : 120;
                                        if (t.length <= m) return t;
                                        return t.slice(0, m) + '…';
                                    };
                                    profileSaveDockMirror(
                                        '[个人资料] 保存成功 · 已关闭面板 — ' + flowLabel
                                    );
                                    profileSaveDockMirror(
                                        '  key=' +
                                            truncate(rec.keyStr, 48) +
                                            ' | ownerId=' +
                                            truncate(ownerIdForAvatar, 72)
                                    );
                                    profileSaveDockMirror(
                                        '  服务端回填 KV: avatar_url=' +
                                            truncate((savedVal && savedVal.avatar_url) || '(空)') +
                                            ' | r2_key=' +
                                            truncate((savedVal && savedVal.avatar_r2_key) || '(空)')
                                    );
                                    if (
                                        savedVal &&
                                        savedVal.avatar_data_url &&
                                        String(savedVal.avatar_data_url).indexOf('data:') === 0
                                    ) {
                                        profileSaveDockMirror(
                                            '  （另含 avatar_data_url 内嵌图，省略显示）'
                                        );
                                    }
                                    if (x && x.avatarUpload) {
                                        var au = x.avatarUpload;
                                        profileSaveDockMirror(
                                            '  avatar-save: media_url=' +
                                                truncate(au.media_url || '(空)') +
                                                ' | r2=' +
                                                truncate(au.r2_key || '')
                                        );
                                        if (au.kv_avatar_sync != null && typeof au.kv_avatar_sync === 'object') {
                                            profileSaveDockMirror(
                                                '  KV 头像同步 kv_avatar_sync: ' +
                                                    JSON.stringify(au.kv_avatar_sync)
                                            );
                                        }
                                    }
                                } catch (eDbg) {
                                    try {
                                        console.error(
                                            dbgTagged(DBG_A0002_2, '[头像诊断][个人资料]'),
                                            eDbg && eDbg.message ? eDbg.message : eDbg
                                        );
                                    } catch (_eLog) {}
                                }
                                try {
                                    if (typeof window.__L_ENG_debugDockOpen === 'function') {
                                        window.__L_ENG_debugDockOpen();
                                    }
                                } catch (eOpen) {}
                            })();
                            try {
                                var diagSnap =
                                    (x.j && x.j.avatar_diagnostics) || null;
                                if (!diagSnap) {
                                    console.warn(
                                        dbgTagged(
                                            DBG_A0002_2,
                                            '[头像诊断][个人资料保存后] JSON 顶层无 avatar_diagnostics，请比对 Network→update-kv-profile 响应'
                                        )
                                    );
                                    diagSnap = {
                                        probe_error:
                                            '缺失 avatar_diagnostics：请确认 Functions 已部署或在 Network 中查看最后一次 update-kv-profile'
                                    };
                                }
                                emitAvatarDiagnosticsToDebugDock('个人资料保存后', diagSnap);
                            } catch (eAd) {
                                console.error(
                                    dbgTagged(DBG_A0002_2, '[头像诊断][个人资料保存后] emit 失败'),
                                    eAd
                                );
                            }
                            if (x && x.avatarUpload) {
                                var d1r2Mismatch =
                                    String((savedVal && savedVal.avatar_r2_key) || '') !==
                                    String(x.avatarUpload.r2_key || '');
                                if (d1r2Mismatch) {
                                    console.warn(
                                        dbgTagged(DBG_A0002_2, '[avatar] kv vs avatar-save r2_key mismatch'),
                                        {
                                            kv_avatar_r2_key: (savedVal && savedVal.avatar_r2_key) || '',
                                            avatar_save_r2_key: x.avatarUpload.r2_key || '',
                                            owner_id: ownerIdForAvatar || ''
                                        }
                                    );
                                }
                            }
                            }
                            fillProfileOriginalPasswordField(
                                savedVal && savedVal.pwd != null ? String(savedVal.pwd) : '',
                                !!(
                                    savedVal &&
                                    (savedVal.pwd_hash || savedVal.password_hash)
                                )
                            );
                            if (profileNewPasswordInput) {
                profileNewPasswordInput.value = '';
                setProfileNewPasswordVisible(false);
            }
                            applyPinyinInitialsToEl(nameNew, profileAvatarInitials);
                            applyHomeComposerAvatarFromProfileSave(savedVal);
                            refreshTopAuthChrome();
                            showBriefAppHint('个人资料已保存');
                            closeProfileModal();
                        } else {
                            var msg =
                                (x.j && (x.j.error || x.j.msg)) ||
                                ('HTTP ' + (x.status != null ? x.status : '错误'));
                            var extra = '';
                            if (x.j && x.j.hint) {
                                extra += '\n' + String(x.j.hint);
                            }
                            var errStr = x.j && x.j.error != null ? String(x.j.error) : '';
                            var kvNotConfigured =
                                errStr.indexOf('KV not configured') >= 0 ||
                                errStr.indexOf('not configured') >= 0;
                            if (Number(x.status) === 503 && kvNotConfigured) {
                                extra +=
                                    '\n\n说明：本次为应用返回的「KV 未绑定」类错误。请到 Pages Production/Preview 的 Functions 绑定中确认变量名为 my_kv。' +
                                    '备选头像是 data URL，与外链路径无关。';
                            } else if (Number(x.status) === 503) {
                                extra +=
                                    '\n\n说明：HTTP 503 但未见「KV not configured」JSON 时，多为边缘短暂故障或非 JSON 错误页。' +
                                    '若同页 /api/env-check 显示 has_my_kv:true，则与「未绑 KV」通常不一致，请稍后重试；' +
                                    '若可复现，请在开发者工具 Network 中打开 update-kv-profile 查看 Response 正文。';
                                if (x.textSnippet) {
                                    console.warn('[update-kv-profile] 非成功响应片段', x.status, x.textSnippet);
                                }
                            }
                            try {
                                var failLine1 = dbgTagged(
                                    DBG_A0002_2,
                                    '[个人资料] 保存失败 · 面板未关闭 — HTTP ' +
                                        String(x.status != null ? x.status : '') +
                                        ' ' +
                                        truncateStr(msg || '', 280)
                                );
                                var failExtra =
                                    extra && String(extra).trim()
                                        ? dbgTagged(
                                              DBG_A0002_2,
                                              '  说明:' + truncateStr(extra.replace(/\n/g, ' · '), 400)
                                          )
                                        : '';
                                var dockFailOk = false;
                                try {
                                    if (typeof window.__L_ENG_debugDockPrint === 'function') {
                                        window.__L_ENG_debugDockPrint('warn', failLine1);
                                        dockFailOk = true;
                                        if (failExtra) window.__L_ENG_debugDockPrint('warn', failExtra);
                                    }
                                } catch (_eWp) {}
                                if (!dockFailOk) {
                                    try {
                                        console.warn(failLine1);
                                        if (failExtra) console.warn(failExtra);
                                    } catch (_eWs) {}
                                }
                            } catch (eDw) {}
                            try {
                                if (typeof window.__L_ENG_debugDockOpen === 'function') {
                                    window.__L_ENG_debugDockOpen();
                                }
                            } catch (eOpen2) {}
                            alert('后台保存失败：' + msg + extra + '\n\n本地数据未修改。');
                        }
                        function truncateStr(s, n) {
                            var t = String(s == null ? '' : s);
                            var m = typeof n === 'number' ? n : 260;
                            if (t.length <= m) return t;
                            return t.slice(0, m) + '…';
                        }
                    })
                    .catch(function (err) {
                        btn.disabled = false;
                        btn.textContent = prevText;
                        console.error(err);
                        try {
                            var errTxt = dbgTagged(
                                DBG_A0002_2,
                                '[个人资料] 保存异常 · 面板未关闭 — ' +
                                    (err && err.message ? String(err.message) : String(err || ''))
                            );
                            var dockErrOk = false;
                            try {
                                if (typeof window.__L_ENG_debugDockPrint === 'function') {
                                    window.__L_ENG_debugDockPrint('error', errTxt);
                                    dockErrOk = true;
                                }
                            } catch (_eWp2) {}
                            if (!dockErrOk) {
                                try {
                                    console.error(errTxt);
                                } catch (_eCe) {}
                            }
                        } catch (eDw2) {}
                        try {
                            if (typeof window.__L_ENG_debugDockOpen === 'function') {
                                window.__L_ENG_debugDockOpen();
                            }
                        } catch (eOpen3) {}
                        alert('后台保存失败：网络异常\n本地数据未修改。');
                    });
            });
        }

        // 用闭包内的版本覆盖对外接口
        window.openProfileModal = openProfileModal;
        window.closeProfileModal = closeProfileModal;
        window.openUserProfileModal = openProfileModal;
    }

    // ================================================================
    // 4. 导出对外接口（由 initProfile 闭包覆盖）
    // ================================================================

    window.openProfileModal = function () {
        injectProfileCSS();
        injectProfileHTML();
        initProfile();
        // init 完成后已换成闭包内 open；再调一次真正打开
        if (profileInited && typeof window.openProfileModal === 'function') {
            window.openProfileModal();
        }
    };
    window.closeProfileModal = function () {};
    window.openUserProfileModal = window.openProfileModal;

    window.L_ENG_Profile = {
        get open() { return window.openProfileModal; },
        get close() { return window.closeProfileModal; }
    };

    // ================================================================
    // 5. 自动初始化
    // ================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            injectProfileCSS();
            injectProfileHTML();
            setTimeout(initProfile, 0);
        });
    } else {
        injectProfileCSS();
        injectProfileHTML();
        setTimeout(initProfile, 0);
    }
})();