/**
 * L-ENG 登录/注册模块
 * 从 public/index.html 提取，管理注册面板与新人注册面板的展示/关闭逻辑。
 * 
 * 依赖（由 index.html 暴露为 window 全局）：
 *   - window.loginDebugDockEmit(level, message)  登录诊断输出
 *   - window.markProfileNavUnlockedByLogin(…)     解锁个人资料导航
 *   - window.bindPasswordHalfwidthInput(el)       密码框半角输入修正
 *   - window.persistRegistrationReceiptSuccess(…) KV 注册成功凭据
 *   - window.persistRegistrationReceiptFailure(…) KV 注册失败凭据
 *   - window.unlockProfileNavPersist()            持久化解锁标志
 *   - window.stopPolling()                        停止二维码轮询
 *   - window.qrTimer / window.registerQrCountdownInterval / window.registerQrExpireTimer
 *
 * 对外接口：window.L_ENG_Register = { open, openNew, close, closeNew }
 */
(function () {
    // 外部 DOM 引用（声明于 index.html 作用域，此处重新获取）
    var topRegisterBtn = document.getElementById('topRegisterBtn');
    var topAuthDropdown = document.getElementById('topAuthDropdown');
    var topNavNewRegister = document.getElementById('topNavNewRegister');
    var topNavUserLogin = document.getElementById('topNavUserLogin');
    var topNavUserList = document.getElementById('topNavUserList');
    var topNavAvatarManage = document.getElementById('topNavAvatarManage');

            var registerPanel = document.getElementById('registerPanel');
            var newUserRegisterPanel = document.getElementById('newUserRegisterPanel');
            var newUserRegisterCloseBtn = document.getElementById('newUserRegisterCloseBtn');
            var newUserRegPhoneNextBtn = document.getElementById('newUserRegPhoneNextBtn');
            var newUserRegNameInput = document.getElementById('newUserRegNameInput');
            var newUserRegPhoneInput = document.getElementById('newUserRegPhoneInput');
            var newUserRegPwdInput = document.getElementById('newUserRegPwdInput');
            window.bindPasswordHalfwidthInput(newUserRegPwdInput);
            var newUserRegInviteRow = document.getElementById('newUserRegInviteRow');
            var newUserRegInviteCodeInput = document.getElementById('newUserRegInviteCodeInput');
            /** 组长专属链接写入：与 URL ?group= / ?g= 同步后仅存 session，新人一律 g_role=0（组员） */
            var REGISTER_GROUP_LOCK_STORAGE_KEY = 'L_ENG_register_group_lock_v1';
            /** 全站默认组（KV），由 GET/POST /api/default-register-group 同步 */
            var defaultRegisterGroupServerCache = { loaded: false, group: '' };
            /** 当前默认组在 KV 中的六位邀请码（用于链接展示，可为空） */
            var hintDefaultGroupInviteCode = '';

            function normalizeInviteSixDigits(raw) {
                var d = String(raw || '').replace(/\D/g, '').slice(0, 6);
                return d.length === 6 ? d : '';
            }

            function sanitizeRegisterGroupParam(raw) {
                if (raw == null) return '';
                var s = String(raw).trim();
                if (!s || s.length > 24) return '';
                if (!/^[\dA-Za-z._-]+$/.test(s)) return '';
                return s;
            }

            function readRegisterGroupLock() {
                try {
                    var raw = sessionStorage.getItem(REGISTER_GROUP_LOCK_STORAGE_KEY);
                    if (!raw) return null;
                    var o = JSON.parse(raw);
                    var g = o && o.group != null ? sanitizeRegisterGroupParam(o.group) : '';
                    if (!g) return null;
                    var inv = o && o.invite != null ? normalizeInviteSixDigits(o.invite) : '';
                    return { group: g, invite: inv || '' };
                } catch (e) {
                    return null;
                }
            }

            function getEffectiveRegisterGroupForNewUser() {
                var lock = readRegisterGroupLock();
                if (lock && lock.group) return { group: lock.group, source: 'link' };
                var g = sanitizeRegisterGroupParam(defaultRegisterGroupServerCache.group || '');
                if (g) return { group: g, source: 'server_default' };
                return null;
            }

            function stripRegisterGroupQueryFromLocation() {
                try {
                    var u = new URL(window.location.href);
                    if (
                        !u.searchParams.has('group') &&
                        !u.searchParams.has('g') &&
                        !u.searchParams.has('invite')
                    ) {
                        return;
                    }
                    u.searchParams.delete('group');
                    u.searchParams.delete('g');
                    u.searchParams.delete('invite');
                    var q = u.searchParams.toString();
                    var next = u.pathname + (q ? '?' + q : '') + u.hash;
                    window.history.replaceState(null, '', next);
                } catch (e2) {}
            }

            function initRegisterGroupLockFromUrl() {
                try {
                    var u = new URL(window.location.href);
                    var raw = u.searchParams.get('group');
                    if (raw == null || raw === '') raw = u.searchParams.get('g');
                    var g = sanitizeRegisterGroupParam(raw);
                    if (!g) return;
                    var invRaw = u.searchParams.get('invite');
                    var inv = invRaw != null ? normalizeInviteSixDigits(invRaw) : '';
                    var payload = { group: g, from: 'url' };
                    if (inv) payload.invite = inv;
                    sessionStorage.setItem(REGISTER_GROUP_LOCK_STORAGE_KEY, JSON.stringify(payload));
                    stripRegisterGroupQueryFromLocation();
                } catch (e) {}
            }

            function syncNewUserRegisterGroupLockUI() {
                syncNewUserRegInviteRow();
            }

            function syncNewUserRegInviteRow() {
                var eff = getEffectiveRegisterGroupForNewUser();
                if (!newUserRegInviteRow) return;
                newUserRegInviteRow.hidden = !(eff && eff.group);
            }

            /** 无邀请链接且走服务器默认组时，用同组 KV 邀请码预填输入框（链接里的 invite 优先） */
            function applyNewUserInvitePrefillFromServerDefault() {
                if (!newUserRegInviteCodeInput) return;
                var lock = readRegisterGroupLock();
                if (lock && lock.invite) {
                    newUserRegInviteCodeInput.value = lock.invite;
                    return;
                }
                var eff = getEffectiveRegisterGroupForNewUser();
                if (eff && eff.source === 'server_default') {
                    var h = normalizeInviteSixDigits(hintDefaultGroupInviteCode || '');
                    newUserRegInviteCodeInput.value = h || '';
                    return;
                }
                newUserRegInviteCodeInput.value = '';
            }

            function updateUserListInviteLinkHint() {
                if (!userListInviteLinkHint) return;
                var origin = '';
                try {
                    origin = window.location.origin || '';
                } catch (e) {}
                if (!origin) {
                    userListInviteLinkHint.textContent = '';
                    userListInviteLinkHint.removeAttribute('title');
                    return;
                }
                var g = sanitizeRegisterGroupParam(defaultRegisterGroupServerCache.group || '');
                if (g) {
                    var fullUrl = origin + '/?group=' + encodeURIComponent(g);
                    var inv = normalizeInviteSixDigits(hintDefaultGroupInviteCode || '');
                    if (inv) {
                        fullUrl += '&invite=' + encodeURIComponent(inv);
                    }
                    userListInviteLinkHint.textContent =
                        '组长邀请链接（复制发给新人）：' + fullUrl;
                    userListInviteLinkHint.setAttribute('title', fullUrl);
                } else {
                    userListInviteLinkHint.textContent =
                        '保存默认组后，这里会显示完整链接。格式：' + origin + '/?group=组号（字母数字与 ._-）';
                    userListInviteLinkHint.removeAttribute('title');
                }
            }

            function defaultRegisterGroupApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/default-register-group'
                    : (apiBase || '') + '/api/default-register-group';
            }

            function groupInviteCodeApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/group-invite-code'
                    : (apiBase || '') + '/api/group-invite-code';
            }

            function refreshHintDefaultGroupInviteCode() {
                var g = sanitizeRegisterGroupParam(defaultRegisterGroupServerCache.group || '');
                if (!g) {
                    hintDefaultGroupInviteCode = '';
                    updateUserListInviteLinkHint();
                    return Promise.resolve();
                }
                return fetch(
                    groupInviteCodeApiUrl() + '?group=' + encodeURIComponent(g),
                    { method: 'GET', cache: 'no-store' }
                )
                    .then(function (r) {
                        return r.text().then(function (text) {
                            var j = null;
                            if (text) {
                                try {
                                    j = JSON.parse(text);
                                } catch (e) {}
                            }
                            return { ok: r.ok, j: j };
                        });
                    })
                    .then(function (x) {
                        hintDefaultGroupInviteCode = '';
                        if (x.ok && x.j && x.j.success === true && x.j.code != null) {
                            hintDefaultGroupInviteCode =
                                normalizeInviteSixDigits(String(x.j.code)) || '';
                        }
                        var dg = sanitizeRegisterGroupParam(
                            defaultRegisterGroupServerCache.group || ''
                        );
                        updateUserListInviteLinkHint();
                        if (dg) {
                            window.userManageGroupInviteCodeCache[dg] = hintDefaultGroupInviteCode || '';
                        }
                        if (userManageGroupTree) {
                            renderUserManageGroupTree(userListAllRowsCache);
                        }
                    })
                    .catch(function () {
                        hintDefaultGroupInviteCode = '';
                        updateUserListInviteLinkHint();
                        var dgFail = sanitizeRegisterGroupParam(
                            defaultRegisterGroupServerCache.group || ''
                        );
                        if (dgFail) {
                            window.userManageGroupInviteCodeCache[dgFail] = '';
                        }
                        if (userManageGroupTree) {
                            renderUserManageGroupTree(userListAllRowsCache);
                        }
                    });
            }

            function refreshDefaultRegisterGroupFromServer() {
                return fetch(defaultRegisterGroupApiUrl(), { method: 'GET', cache: 'no-store' })
                    .then(function (r) {
                        return r.text().then(function (text) {
                            var j = null;
                            if (text) {
                                try {
                                    j = JSON.parse(text);
                                } catch (e) {}
                            }
                            return { ok: r.ok, j: j };
                        });
                    })
                    .then(function (x) {
                        defaultRegisterGroupServerCache.loaded = true;
                        var g = '';
                        if (x.ok && x.j && x.j.success === true && x.j.group != null) {
                            g = sanitizeRegisterGroupParam(String(x.j.group));
                        }
                        defaultRegisterGroupServerCache.group = g || '';
                    })
                    .catch(function (err) {
                        console.warn('[default-register-group] GET failed', err);
                        defaultRegisterGroupServerCache.loaded = true;
                    });
            }

            function syncUserListDefaultRegisterGroupPanel() {
                refreshDefaultRegisterGroupFromServer()
                    .then(function () {
                        if (userListDefaultRegisterGroupInput) {
                            userListDefaultRegisterGroupInput.value =
                                defaultRegisterGroupServerCache.group || '';
                        }
                        return refreshHintDefaultGroupInviteCode();
                    })
                    .catch(function () {
                        if (userListDefaultRegisterGroupInput) {
                            userListDefaultRegisterGroupInput.value =
                                defaultRegisterGroupServerCache.group || '';
                        }
                        updateUserListInviteLinkHint();
                    });
            }

            initRegisterGroupLockFromUrl();
            refreshDefaultRegisterGroupFromServer().then(function () {
                return refreshHintDefaultGroupInviteCode();
            });

            var registerScanCol = document.getElementById('registerScanCol');
            var registerSubmitBtn = document.getElementById('registerSubmitBtn');
            var registerPhoneInput = document.getElementById('registerPhoneInput');
            var registerPwdInput = document.getElementById('registerPwdInput');
            window.bindPasswordHalfwidthInput(registerPwdInput);
            var registerCloseBtn = document.getElementById('registerCloseBtn');
            var registerLoginCodeBtn = document.getElementById('registerLoginCodeBtn');
            var registerLoginStatusPwd = document.getElementById('registerLoginStatusPwd');
            var registerLoginStatusCode = document.getElementById('registerLoginStatusCode');
            var registerSendCodeCooldownLabel = document.getElementById('registerSendCodeCooldownLabel');
            var registerSendCodeCooldownInterval = null;
            var registerEmailVerificationCode = null;
            var registerEmailVerificationBind = null;
            var registerEmailCodeSending = false; // 防重发：扫码登录时避免并发发送两次验证码
            var registerPwdNotFoundCount = 0;
            var registerPwdWrongCount = 0;
            var registerSuperAuthHint = document.getElementById('registerSuperAuthHint');

            function setRegisterLoginStatus(which, message, kind) {
                var el =
                    which === 'code'
                        ? registerLoginStatusCode
                        : which === 'pwd'
                          ? registerLoginStatusPwd
                          : registerLoginStatusPwd || registerLoginStatusCode;
                var text = String(message == null ? '' : message);
                var k = kind === 'ok' || kind === 'error' || kind === 'pending' ? kind : '';
                if (el) {
                    el.textContent = text;
                    el.classList.remove('is-ok', 'is-error', 'is-pending');
                    if (k) el.classList.add('is-' + k);
                }
                if (text) {
                    var level = k === 'error' ? 'error' : k === 'ok' ? 'log' : 'info';
                    try {
                        window.loginDebugDockEmit(level, '[登录] ' + text);
                    } catch (eEmit) {}
                }
            }
            var registerSuperAuthState = {
                phone: '',
                codeVerified: false,
                pwdVerified: false,
                isSuperuser: false,
                /** 超级用户先过密码再过邮箱验证时，第二步需带回已验密码写入收据，供个人资料「原密码」展示 */
                lastVerifiedPassword: ''
            };
            var ADMIN_MENU_UNLOCKED_KEY = 'L_ENG_admin_menu_unlocked_v1';
            var registerTabs = document.querySelectorAll('.register-tab');
            var registerTabPanels = {
                pwd: document.getElementById('registerTabPwd'),
                code: document.getElementById('registerTabCode')
            };
            var turnstileOverlay = document.getElementById('turnstileOverlay');
            var turnstileCancelBtn = document.getElementById('turnstileCancelBtn');
            var turnstileWidgetMount = document.getElementById('turnstileWidgetMount');
            var turnstileWidgetId = null;
            var cameraQrImg = document.getElementById('cameraQrImg');
            var submitBtn = document.getElementById('submitBtn');
            var formInputs = document.querySelectorAll('.action-wrap input');
            var verificationCode = null;
            var isFirstSubmit = true;
            var isAuthFlowActive = false;

            function generateSessionId() {
                return typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID()
                    : 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
            }

            function getLocalIP() {
                return new Promise(function (resolve) {
                    var pageHost = window.location.hostname;
                    var fallbackHost =
                        pageHost && pageHost !== 'localhost' && pageHost !== '127.0.0.1'
                            ? pageHost
                            : '127.0.0.1';
                    fetch('/api/get-local-ip')
                        .then(function (response) {
                            if (response.ok) return response.json();
                            throw new Error('获取 IP 失败');
                        })
                        .then(function (data) {
                            resolve(data.ip || fallbackHost);
                        })
                        .catch(function () {
                            resolve(fallbackHost);
                        });
                });
            }

            function stopRegisterQrCountdownTimers() {
                if (window.registerQrCountdownInterval) {
                    clearInterval(window.registerQrCountdownInterval);
                    window.registerQrCountdownInterval = null;
                }
                if (window.registerQrExpireTimer) {
                    clearTimeout(window.registerQrExpireTimer);
                    window.registerQrExpireTimer = null;
                }
            }

            function clearRegisterQrCountdownUI() {
                stopRegisterQrCountdownTimers();
                var cel = document.getElementById('registerQrCountdown');
                if (cel) cel.textContent = '';
            }

            /** 二维码 5 分钟失效倒计时（与下方变淡一致） */
            function startRegisterQrCountdown(sessionId) {
                stopRegisterQrCountdownTimers();
                var el = document.getElementById('registerQrCountdown');
                var secondsLeft = 300;
                function fmt(sec) {
                    var m = Math.floor(sec / 60);
                    var s = sec % 60;
                    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
                }
                function tick() {
                    if (!el) return;
                    if (secondsLeft <= 0) {
                        el.textContent = '二维码已失效';
                        if (window.registerQrCountdownInterval) {
                            clearInterval(window.registerQrCountdownInterval);
                            window.registerQrCountdownInterval = null;
                        }
                        return;
                    }
                    el.textContent = '失效倒计时 ' + fmt(secondsLeft);
                    secondsLeft--;
                }
                tick();
                window.registerQrCountdownInterval = setInterval(tick, 1000);
                window.registerQrExpireTimer = setTimeout(function () {
                    if (cameraQrImg && cameraQrImg.dataset.sessionId === sessionId) {
                        cameraQrImg.style.opacity = '0.35';
                    }
                }, 5 * 60 * 1000);
            }

            function switchRegisterTab(name) {
                registerTabs.forEach(function (t) {
                    var on = t.getAttribute('data-rtab') === name;
                    t.classList.toggle('active', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                Object.keys(registerTabPanels).forEach(function (key) {
                    var p = registerTabPanels[key];
                    if (p) p.classList.toggle('active', key === name);
                });
                /** 密码登录 Tab 下停止 scan-login 轮询，避免网络/控制台刷屏；切回验证码登录且面板仍打开时恢复 */
                if (name === 'pwd') {
                    window.stopPolling();
                } else if (name === 'code') {
                    if (registerPanel && registerPanel.classList.contains('show') && cameraQrImg && cameraQrImg.dataset.sessionId) {
                        startPolling(cameraQrImg.dataset.sessionId);
                    }
                }
            }

            /** 注册写入 KV 的 Metadata 默认结构（见喂0402/0403.pdf；表格示例见喂PDF0405.pdf） */
            function getDefaultRegisterMetadata() {
                return {
                    status: 1,
                    type: '00010000',
                    superuser: '00000000',
                    dbg_stf: '00000000',
                    cnt_mgr: '00000000',
                    cnt_stf: '00000000',
                    uA: '00010000',
                    uB: '00000000',
                    uC: '00000000',
                    uA_perms: '00001111',
                    uA_perms_add: '000000001',
                    uA_perms_del: '000000010',
                    uA_perms_block: '000000100',
                    uA_perms_unban_usr: '000001000',
                    uA_act_perms: '00001111',
                    uA_perms_act_post: '00000001',
                    uA_perms_act_cmt: '00000010',
                    uA_perms_act_hide: '00000100',
                    uA_perms_act_del: '00001000',
                    stfA_perms_can_ban_post: 3,
                    uA_Tier: 4,
                    uB_Tier: 1,
                    uC_Tier: 1,
                    uC_EType: 1,
                    uC_Tier_twn: '00000001',
                    uC_Tier_cty: '00000010',
                    uC_Tier_city: '00000100',
                    uC_Tier_prov: '00001000',
                    uC_EType1: '00000001',
                    uC_EType2: '00000010',
                    uC_EType3: '00000100'
                };
            }

            function hideNewUserKvPreview() {
                var el = document.getElementById('newUserKvPreview');
                if (el) el.style.display = 'none';
                var st = document.getElementById('newUserKvSaveStatus');
                if (st) {
                    st.hidden = true;
                    st.textContent = '';
                    st.classList.remove('is-error');
                }
            }

            function showNewUserKvPreview(key, valueObj, metadataObj) {
                var el = document.getElementById('newUserKvPreview');
                var kEl = document.getElementById('newUserKvKeyText');
                var vEl = document.getElementById('newUserKvValueJson');
                var mEl = document.getElementById('newUserKvMetadataJson');
                var st = document.getElementById('newUserKvSaveStatus');
                if (!el || !kEl || !vEl || !mEl) return;
                if (st) {
                    st.hidden = true;
                    st.textContent = '';
                    st.classList.remove('is-error');
                }
                kEl.textContent = key;
                vEl.textContent = JSON.stringify(valueObj, null, 2);
                mEl.textContent = JSON.stringify(metadataObj, null, 2);
                el.style.display = 'block';
                requestAnimationFrame(function () {
                    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
            }

            function setNewUserKvSaveStatus(message, isError) {
                var st = document.getElementById('newUserKvSaveStatus');
                if (!st) return;
                st.textContent = message || '';
                st.classList.toggle('is-error', !!isError);
                st.hidden = !message;
            }

            // 先定义异步调用scan-login的handleScannedResult，为下一步refreshCameraQr函数做准备
            // 这也是轮询检查扫码结果
            async function handleScannedResult(sessionId) {
                try {
                const response = await fetch(
                    '/api/scan-login?sessionId=' + encodeURIComponent(sessionId) + '&_t=' + Date.now(),
                    { cache: 'no-store' }
                );
                var result = await response.json();
                if (result.exists && result.data) {
                    clearInterval(window.qrTimer); // 停止轮询
                    window.qrTimer = null;

                    // 防重发：避免轮询并发时重复发送验证码
                    if (registerEmailCodeSending) return;
                    registerEmailCodeSending = true;

                    var usernameEl = document.getElementById('registerCodeUsernameInput');
                    var phoneEl = document.getElementById('registerCodePhoneInput');
                    var emailEl = document.getElementById('registerCodeEmailInput');
                    var username = usernameEl ? usernameEl.value.trim() : '';
                    var phone = phoneEl ? phoneEl.value.trim() : '';
                    var email = emailEl ? emailEl.value.trim() : '';
                    setRegisterLoginStatus('code', '已检测到扫码，正在发送邮箱验证码…', 'pending');
                    if (!username || !phone || !email) {
                        registerEmailCodeSending = false;
                        setRegisterLoginStatus(
                            'code',
                            '请先填写用户名、手机号、邮箱，再扫码获取验证码',
                            'error'
                        );
                        alert('请先填写好用户名、手机号、邮箱，再用手机相机扫描二维码，以获取验证码！');
                        refreshCameraQr();
                        return;
                    }

                    var sentOk = await registerSendEmailCodeHandler();
                    if (!sentOk) {
                        registerEmailCodeSending = false;
                        refreshCameraQr();
                        return;
                    }
                    registerEmailCodeSending = false;
                    if (cameraQrImg) cameraQrImg.style.opacity = '0.3';
                    setRegisterLoginStatus(
                        'code',
                        '验证码已发送；未收到邮件请按 F12 在 Console 查看',
                        'ok'
                    );
                } else {
                    console.log('轮询中: 会话尚未写入', sessionId);
                }
                } catch (error) {
                    console.error('轮询出错:', error);
                    setRegisterLoginStatus(
                        'code',
                        '扫码轮询失败：' + String((error && error.message) || error || '网络异常'),
                        'error'
                    );
                }
            }
            // 提取轮询逻辑，采用 setInterval 确保固定间隔轮询
            function startPolling(sessionId) {
                // 清除之前的定时器
                if (window.qrTimer) {
                    clearInterval(window.qrTimer);
                    window.qrTimer = null;
                }
                
                // 先建立定时器，再立即执行一次检查（确保 handleScannedResult 内能停止轮询）
                window.qrTimer = setInterval(async () => {
                    if (!registerPanel || !registerPanel.classList.contains('show')) {
                        clearInterval(window.qrTimer);
                        window.qrTimer = null;
                        return;
                    }
                    if (registerTabPanels.pwd && registerTabPanels.pwd.classList.contains('active')) {
                        return;
                    }
                    await handleScannedResult(sessionId);
                }, 250); // 再缩短到 250ms，提升扫码后的感知速度
                
                // 立即执行一次检查
                handleScannedResult(sessionId);
            }

            function refreshCameraQr() {
                if (!cameraQrImg) return;
                if (window.qrTimer) clearInterval(window.qrTimer);
                stopRegisterQrCountdownTimers();
                registerEmailCodeSending = false; // 二维码刷新时重置防重发标志
                var sessionId = generateSessionId();
                cameraQrImg.dataset.sessionId = sessionId;
                cameraQrImg.style.opacity = '1';
                startRegisterQrCountdown(sessionId);
                setRegisterLoginStatus('code', '请填写信息后用手机相机扫码', 'pending');

                var host = window.location.hostname || '';
                var isLocalHost =
                    host === 'localhost' ||
                    host === '127.0.0.1' ||
                    host === '0.0.0.0' ||
                    host === '[::1]';
                var isLocalDev = !!(window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV) || isLocalHost;

                if (!isLocalDev && window.location.origin) {
                    /** 线上 Pages：二维码必须指向当前站点，手机才能打开 mobile.html */
                    console.log('使用站点 origin 生成二维码:', window.location.origin);
                    generateQrCode(window.location.origin, sessionId);
                    return;
                }

                getLocalIP().then(function (localIP) {
                    var port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
                    var proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
                    var baseUrl = proto + '//' + localIP + (port && port !== '80' && port !== '443' ? ':' + port : '');
                    console.log('使用局域网 IP 生成二维码:', baseUrl);
                    generateQrCode(baseUrl, sessionId);
                });
            }
            
            // 二维码生成辅助函数 - 支持环境切换
            function generateQrCode(baseUrl, sessionId) {
                // 获取配置
                const config = window.APP_CONFIG || {};
                const qrConfig = config.QR_CONFIG || { generator: 'qrserver', size: 140 };
                const isLocalDev = config.IS_LOCAL_DEV || false;
                
                // 生成扫码 URL
                var scanUrl = baseUrl + '/mobile.html?sessionId=' + encodeURIComponent(sessionId);
                
                // 调试信息
                console.log('生成的二维码 URL:', scanUrl);
                console.log('sessionId:', sessionId);
                console.log('环境:', isLocalDev ? '本地开发' : '生产环境');
                console.log('二维码生成器:', qrConfig.generator);
                
                // 在控制台输出大大的提示，方便调试
                console.log('%c [QR CODE URL] ' + scanUrl, 'background: #222; color: #bada55; font-size: 20px');
                
                // 恢复透明度（防止之前过期变淡了）
                cameraQrImg.style.opacity = "1";
                
                // 根据配置选择二维码生成方式
                if (qrConfig.generator === 'qrcodejs' && typeof QRCode !== 'undefined') {
                    // 使用 QRCode.js 库（生产环境推荐）
                    console.log('使用 QRCode.js 生成二维码');
                    
                    QRCode.toDataURL(scanUrl, { 
                        width: qrConfig.size, 
                        margin: qrConfig.margin, 
                        color: qrConfig.color 
                    }, function (err, url) {
                        if (!err) {
                            cameraQrImg.src = url; 
                            cameraQrImg.style.opacity = "1"; 
                            cameraQrImg.style.width = qrConfig.size + 'px';
                            cameraQrImg.style.height = qrConfig.size + 'px';
                            cameraQrImg.style.margin = '0 auto';
                            cameraQrImg.style.display = 'block';
                            
                            console.log('二维码图片成功从 QRCode.js 生成！');
                            startPolling(sessionId);    // 启动轮询
                        } else {
                            console.error('QRCode.js 生成失败:', err);
                            // 降级到 QRServer API
                            generateWithQRServer(scanUrl, sessionId, qrConfig.size);
                        }
                    });
                } else {
                    // 使用 QRServer API（本地开发环境默认）
                    generateWithQRServer(scanUrl, sessionId, qrConfig.size);
                }
                
                // QRServer API 生成函数
                function generateWithQRServer(scanUrl, sessionId, size) {
                    console.log('使用 QRServer API 生成二维码');
                    
                    var qrServerUrl = 'https://api.qrserver.com/v1/create-qr-code/?' + 
                        'size=' + size + 'x' + size + 
                        '&margin=' + (qrConfig.margin || 10) + 
                        '&data=' + encodeURIComponent(scanUrl) + 
                        '&t=' + Date.now();
                    
                    console.log('正在请求二维码:', qrServerUrl);
                    
                    // 强制设置图片属性
                    cameraQrImg.src = qrServerUrl;
                    cameraQrImg.style.display = 'block';
                    cameraQrImg.style.opacity = "1";
                    cameraQrImg.style.width = size + 'px';
                    cameraQrImg.style.height = size + 'px';
                    cameraQrImg.style.margin = '0 auto';
                    
                    // 添加加载成功监听
                    cameraQrImg.onload = function() {
                        console.log('二维码图片成功从 QRServer 加载！');
                        startPolling(sessionId);    // 启动轮询
                    };
                    
                    // 添加加载失败监听
                    cameraQrImg.onerror = function() {
                        console.error('QRServer 图片加载失败');
                        this.alt = '二维码加载失败，请手动访问: ' + scanUrl;
                        // 尝试使用 Canvas 备用方案
                        generateWithCanvas(scanUrl, sessionId, size);
                    };
                }
                
                // Canvas 备用生成函数
                function generateWithCanvas(scanUrl, sessionId, size) {
                    console.log('尝试使用 Canvas 生成二维码');
                    
                    // 创建临时 canvas
                    var canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    var ctx = canvas.getContext('2d');
                    
                    // 绘制简单二维码（备用方案）
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, size, size);
                    ctx.fillStyle = '#000000';
                    ctx.font = '12px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('QR Code', size/2, size/2 - 10);
                    ctx.font = '10px monospace';
                    ctx.fillText('请手动访问:', size/2, size/2 + 10);
                    
                    // 转换为 data URL
                    cameraQrImg.src = canvas.toDataURL();
                    cameraQrImg.style.display = 'block';
                    cameraQrImg.style.opacity = "1";
                    cameraQrImg.style.width = size + 'px';
                    cameraQrImg.style.height = size + 'px';
                    cameraQrImg.style.margin = '0 auto';
                    cameraQrImg.alt = '二维码生成失败，请手动访问: ' + scanUrl;
                    
                    console.warn('使用 Canvas 备用二维码');
                    startPolling(sessionId);    // 启动轮询
                }
            }
            

 
            function closeTurnstileOverlay() {
                if (!turnstileOverlay) return;
                if (turnstileWidgetId !== null && window.turnstile) {
                    try { window.turnstile.remove(turnstileWidgetId); } catch (e) { /* ignore */ }
                    turnstileWidgetId = null;
                }
                if (turnstileWidgetMount) turnstileWidgetMount.innerHTML = '';
                turnstileOverlay.classList.remove('show');
                turnstileOverlay.setAttribute('aria-hidden', 'true');
            }

            function ensureTurnstileScript() {
                return new Promise(function (resolve, reject) {
                    if (window.turnstile) {
                        resolve();
                        return;
                    }
                    var existing = document.getElementById('cf-turnstile-api-js');
                    if (existing) {
                        if (window.turnstile) {
                            resolve();
                            return;
                        }
                        existing.addEventListener('load', function onLoad() {
                            existing.removeEventListener('load', onLoad);
                            if (window.turnstile) resolve();
                            else reject(new Error('Turnstile 未就绪'));
                        });
                        existing.addEventListener('error', function () {
                            reject(new Error('Turnstile 脚本加载失败'));
                        });
                        return;
                    }
                    var s = document.createElement('script');
                    s.id = 'cf-turnstile-api-js';
                    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                    s.async = true;
                    s.defer = true;
                    s.onload = function () { resolve(); };
                    s.onerror = function () { reject(new Error('Turnstile 脚本加载失败')); };
                    document.head.appendChild(s);
                });
            }

            function showTurnstileDiagnosticDialog(reason, cfg, extraDetail) {
                var host = window.location.hostname || '(unknown)';
                var origin = window.location.origin || '(unknown)';
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl
                        : '(empty)';
                var siteKey = (cfg && cfg.siteKey) || '';
                var keyShort = siteKey ? siteKey.slice(0, 12) + '...' : '(empty)';
                var lines = [
                    '人机验证加载失败：' + String(reason || '未知原因'),
                    '',
                    '当前环境：',
                    '- 访问域名：' + host,
                    '- 页面来源：' + origin,
                    '- API baseUrl：' + apiBase,
                    '- siteKey 前缀：' + keyShort,
                    '',
                    '请检查：',
                    '1) Turnstile 控制台该 siteKey 的 Allowed hostnames 已包含当前域名（如 hobby-era.com / www.hobby-era.com）',
                    '2) Cloudflare Pages 环境变量 TURNSTILE_SECRET_KEY 已配置，且与当前 siteKey 匹配',
                    '3) 修改配置后已重新部署，并在浏览器强制刷新（Cmd+Shift+R）',
                    '4) 若仍失败，先暂时关闭代理/VPN 或更换网络后重试'
                ];
                if (extraDetail) {
                    lines.push('', '技术详情：' + String(extraDetail));
                }
                alert(lines.join('\n'));
            }

            /**
             * @param skipVerifyEndpoint 为 true 时不请求 /api/verify-turnstile（token 一次性，留给后续接口如 register-kv 校验）
             */
            function verifyTurnstileToken(token, cfg, onVerified, skipVerifyEndpoint) {
                if (skipVerifyEndpoint) {
                    closeTurnstileOverlay();
                    if (typeof onVerified === 'function') {
                        onVerified(token);
                    } else {
                        openRegister();
                    }
                    return;
                }
                var endpoint = (cfg && cfg.verifyEndpoint) || '/api/verify-turnstile';
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: token })
                })
                    .then(function (r) {
                        return r.json().then(function (j) {
                            return { ok: r.ok, j: j };
                        });
                    })
                    .then(function (x) {
                        if (x.j && x.j.success) {
                            closeTurnstileOverlay();
                            if (typeof onVerified === 'function') {
                                onVerified(token);
                            } else {
                                openRegister();
                            }
                        } else {
                            alert('验证未通过，请重试');
                            if (turnstileWidgetId !== null && window.turnstile) {
                                try { window.turnstile.reset(turnstileWidgetId); } catch (e) { /* ignore */ }
                            }
                        }
                    })
                    .catch(function (err) {
                        console.error(err);
                        showTurnstileDiagnosticDialog('验证服务不可用', cfg, err && err.message);
                    });
            }

            function openTurnstileOverlay(siteKey, cfg, onVerified, skipVerifyEndpoint) {
                if (!turnstileOverlay || !turnstileWidgetMount) return;
                turnstileOverlay.classList.add('show');
                turnstileOverlay.setAttribute('aria-hidden', 'false');
                if (turnstileWidgetId !== null && window.turnstile) {
                    try { window.turnstile.remove(turnstileWidgetId); } catch (e) { /* ignore */ }
                    turnstileWidgetId = null;
                }
                turnstileWidgetMount.innerHTML = '';
                ensureTurnstileScript()
                    .then(function () {
                        turnstileWidgetId = window.turnstile.render(turnstileWidgetMount, {
                            sitekey: siteKey,
                            language: (cfg && cfg.language) || 'zh-cn',
                            theme: 'light',
                            callback: function (token) {
                                verifyTurnstileToken(token, cfg, onVerified, skipVerifyEndpoint);
                            },
                            'error-callback': function (errorCode) {
                                console.warn('Turnstile 组件错误, code:', errorCode);
                                var detail = errorCode ? '错误码: ' + String(errorCode) : '';
                                showTurnstileDiagnosticDialog('Turnstile 组件返回错误 (code: ' + (errorCode || 'unknown') + ')', cfg, detail);
                            },
                            'expired-callback': function () {
                                if (turnstileWidgetId !== null && window.turnstile) {
                                    try { window.turnstile.reset(turnstileWidgetId); } catch (e) { /* ignore */ }
                                }
                            }
                        });
                    })
                    .catch(function (e) {
                        console.error(e);
                        showTurnstileDiagnosticDialog('无法加载 Turnstile 脚本', cfg, e && e.message);
                        closeTurnstileOverlay();
                    });
            }

            function isAppDevDebugEnabled() {
                var dc = window.APP_CONFIG && window.APP_CONFIG.DEV_CONFIG;
                return !!(dc && dc.debug);
            }

            function syncRegisterDevToolbar() {
                var tb = document.getElementById('registerDevToolbar');
                var cb = document.getElementById('registerDebugBypassTurnstile');
                if (!tb) return;
                if (isAppDevDebugEnabled()) {
                    tb.removeAttribute('hidden');
                    tb.classList.add('is-visible');
                    if (cb && sessionStorage.getItem('L_ENG_debug_bypass_turnstile') === '1') {
                        cb.checked = true;
                    }
                } else {
                    tb.setAttribute('hidden', '');
                    tb.classList.remove('is-visible');
                }
            }

            function beginRegisterFlow() {
                if (isAppDevDebugEnabled()) {
                    var bypassEl = document.getElementById('registerDebugBypassTurnstile');
                    if (bypassEl && bypassEl.checked) {
                        openRegister();
                        return;
                    }
                }
                var cfg = window.APP_CONFIG && window.APP_CONFIG.TURNSTILE;
                if (!cfg || !cfg.enabled) {
                    openRegister();
                    return;
                }
                var siteKey = cfg.siteKey;
                if (!siteKey) {
                    if (window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV) {
                        console.warn('Turnstile 未配置 siteKey，跳过验证');
                        openRegister();
                    } else {
                        showTurnstileDiagnosticDialog(
                            '未配置 Turnstile 站点密钥',
                            cfg,
                            'public/config.js 中 TURNSTILE.siteKey 为空'
                        );
                    }
                    return;
                }
                openTurnstileOverlay(siteKey, cfg);
            }

            /* 页面启动时从 /api/turnstile-config 获取 Pages 环境变量中的 siteKey，覆盖 config.js 写死值 */
            (function fetchTurnstileSiteKey() {
                if (window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV) return;
                fetch('/api/turnstile-config', { method: 'GET', cache: 'no-store' })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data && data.success && data.siteKey) {
                            var cfg = window.APP_CONFIG && window.APP_CONFIG.TURNSTILE;
                            if (cfg) {
                                cfg.siteKey = data.siteKey;
                            }
                        }
                    })
                    .catch(function (err) {
                        console.warn('[turnstile] 从 API 获取 siteKey 失败，使用 config.js 默认值', err);
                    });
            })();

            var L_ENG_ELECTRON_ENHANCED_KEY = 'L_ENG_electron_enhanced_mode';

            function isElectronShellAvailable() {
                return typeof window !== 'undefined' && window.electronShell;
            }

            function isElectronAlignSurface() {
                try {
                    return new URLSearchParams(window.location.search || '').get('electronAlign') === '1';
                } catch (eAl0) {
                    return false;
                }
            }

            function isElectronEnhancedModeStored() {
                try {
                    return sessionStorage.getItem(L_ENG_ELECTRON_ENHANCED_KEY) === '1';
                } catch (eAl1) {
                    return false;
                }
            }

            function setElectronEnhancedModeStored(on) {
                try {
                    if (on) sessionStorage.setItem(L_ENG_ELECTRON_ENHANCED_KEY, '1');
                    else sessionStorage.removeItem(L_ENG_ELECTRON_ENHANCED_KEY);
                } catch (eAl2) {}
            }

            function removeElectronShellModeBar() {
                var el = document.getElementById('lEngElectronEnhancedBar');
                if (el && el.parentNode) {
                    try {
                        el.parentNode.removeChild(el);
                    } catch (eRm) {}
                }
            }

            function mountElectronAlignSurfaceBar() {
                var bar = document.createElement('div');
                bar.id = 'lEngElectronEnhancedBar';
                bar.className = 'l-eng-electron-enhanced-bar';
                bar.setAttribute('role', 'region');
                bar.setAttribute('aria-label', '透明对齐小窗');

                var title = document.createElement('div');
                title.className = 'l-eng-electron-enhanced-bar-title';
                title.textContent = '增强模式 · 透明小窗';

                var row = document.createElement('div');
                row.className = 'l-eng-electron-enhanced-bar-row';
                var lab = document.createElement('label');
                lab.className = 'l-eng-electron-enhanced-bar-toggle';
                var inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.setAttribute('aria-label', '鼠标穿透本窗口');
                var sp = document.createElement('span');
                sp.textContent = '鼠标穿透（透视桌面）';
                lab.appendChild(inp);
                lab.appendChild(sp);
                inp.addEventListener('change', function () {
                    try {
                        if (window.electronShell && window.electronShell.setClickThrough) {
                            window.electronShell.setClickThrough(!!inp.checked);
                        }
                    } catch (eCt) {}
                });
                row.appendChild(lab);

                var hint = document.createElement('div');
                hint.className = 'l-eng-electron-enhanced-bar-hint';
                hint.textContent =
                    '穿透开启后，点击会落到桌面其它窗口。请用任务栏或 Alt+Tab（macOS：⌘⇥）回到本小窗，再关闭穿透。';

                var actions = document.createElement('div');
                actions.className = 'l-eng-electron-enhanced-bar-actions';
                var btnClose = document.createElement('button');
                btnClose.type = 'button';
                btnClose.className = 'l-eng-electron-enhanced-bar-btn l-eng-electron-enhanced-bar-btn--ghost';
                btnClose.textContent = '关闭透明小窗';
                btnClose.addEventListener('click', function () {
                    try {
                        if (window.electronShell && window.electronShell.setClickThrough) {
                            window.electronShell.setClickThrough(false);
                        }
                    } catch (eC2) {}
                    if (window.electronShell && window.electronShell.closeAlignWindow) {
                        window.electronShell.closeAlignWindow();
                    }
                });
                actions.appendChild(btnClose);

                bar.appendChild(title);
                bar.appendChild(row);
                bar.appendChild(hint);
                bar.appendChild(actions);
                document.body.appendChild(bar);
            }

            function mountElectronMainEnhancedBar() {
                var bar = document.createElement('div');
                bar.id = 'lEngElectronEnhancedBar';
                bar.className = 'l-eng-electron-enhanced-bar';
                bar.setAttribute('role', 'region');
                bar.setAttribute('aria-label', 'Electron 增强模式');

                var title = document.createElement('div');
                title.className = 'l-eng-electron-enhanced-bar-title';
                title.textContent = '增强模式 · 透明小窗已就绪';

                var hint = document.createElement('div');
                hint.className = 'l-eng-electron-enhanced-bar-hint';
                hint.textContent =
                    '已尝试打开「透明对齐小窗」（置顶）。请在小窗内勾选「鼠标穿透」以透视到桌面；主窗口保持正常点击。';

                var actions = document.createElement('div');
                actions.className = 'l-eng-electron-enhanced-bar-actions';

                var btnOpen = document.createElement('button');
                btnOpen.type = 'button';
                btnOpen.className = 'l-eng-electron-enhanced-bar-btn';
                btnOpen.textContent = '打开 / 聚焦透明小窗';
                btnOpen.addEventListener('click', function () {
                    if (window.electronShell && window.electronShell.openAlignWindow) {
                        window.electronShell.openAlignWindow();
                    }
                });
                actions.appendChild(btnOpen);

                var btnExit = document.createElement('button');
                btnExit.type = 'button';
                btnExit.className = 'l-eng-electron-enhanced-bar-btn l-eng-electron-enhanced-bar-btn--ghost';
                btnExit.textContent = '退出增强模式';
                btnExit.addEventListener('click', function () {
                    try {
                        if (window.electronShell && window.electronShell.setClickThrough) {
                            window.electronShell.setClickThrough(false);
                        }
                    } catch (eE0) {}
                    setElectronEnhancedModeStored(false);
                    try {
                        document.body.classList.remove('l-eng-electron-enhanced');
                    } catch (eE1) {}
                    if (window.electronShell && window.electronShell.closeAlignWindow) {
                        window.electronShell.closeAlignWindow();
                    }
                    removeElectronShellModeBar();
                });
                actions.appendChild(btnExit);

                bar.appendChild(title);
                bar.appendChild(hint);
                bar.appendChild(actions);
                document.body.appendChild(bar);
            }

            function refreshElectronShellModeUi() {
                removeElectronShellModeBar();
                if (!isElectronShellAvailable()) return;
                if (isElectronAlignSurface()) {
                    mountElectronAlignSurfaceBar();
                    return;
                }
                if (isElectronEnhancedModeStored()) {
                    try {
                        document.body.classList.add('l-eng-electron-enhanced');
                    } catch (eB) {}
                    mountElectronMainEnhancedBar();
                }
            }

            function enterElectronEnhancedModeFromMenu() {
                setElectronEnhancedModeStored(true);
                try {
                    document.body.classList.add('l-eng-electron-enhanced');
                } catch (eEn) {}
                refreshElectronShellModeUi();
                if (window.electronShell && window.electronShell.openAlignWindow) {
                    var pr = window.electronShell.openAlignWindow();
                    if (pr && typeof pr.then === 'function') {
                        pr.catch(function () {});
                    }
                }
            }

            // 事件绑定部分（右下角日期仅显示，不再触发弹窗）
            var topAuthHoverEl = document.getElementById('topAuthHover');
            if (topAuthHoverEl && topRegisterBtn && topAuthDropdown) {
                topAuthHoverEl.addEventListener('mouseenter', function () {
                    topRegisterBtn.setAttribute('aria-expanded', 'true');
                    topAuthDropdown.setAttribute('aria-hidden', 'false');
                });
                topAuthHoverEl.addEventListener('mouseleave', function () {
                    topRegisterBtn.setAttribute('aria-expanded', 'false');
                    topAuthDropdown.setAttribute('aria-hidden', 'true');
                });
            }

            var topMoreWrap = document.getElementById('topMoreWrap');
            var topMoreMenuBtn = document.getElementById('topMoreMenuBtn');
            var topMoreMenu = document.getElementById('topMoreMenu');
            var topMoreElectronMode = document.getElementById('topMoreElectronMode');
            function setTopMoreMenuOpen(open) {
                if (!topMoreWrap || !topMoreMenuBtn || !topMoreMenu) return;
                topMoreWrap.classList.toggle('is-open', !!open);
                topMoreMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
                topMoreMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
            }
            function closeTopMoreMenu() {
                setTopMoreMenuOpen(false);
            }
            /** Electron：人人可开；非 Electron：仅超级用户；未登录不可用 */
            function syncTopMoreMenuAccess() {
                if (!topMoreMenuBtn) return;
                var isElectron = !!(window.electronShell && window.electronShell.shellVersion);
                var allow = false;
                if (isElectron) {
                    allow = true;
                } else {
                    var role = window.__currentUserRole;
                    var su = window.USER_TYPE_SUPERUSER || 1;
                    allow = !!(role && ((role.type & su) !== 0));
                }
                topMoreMenuBtn.disabled = !allow;
                topMoreMenuBtn.setAttribute('aria-disabled', allow ? 'false' : 'true');
                if (!allow) closeTopMoreMenu();
            }
            window.syncTopMoreMenuAccess = syncTopMoreMenuAccess;
            if (topMoreMenuBtn && topMoreMenu) {
                topMoreMenuBtn.addEventListener('click', function (ev) {
                    try {
                        ev.preventDefault();
                    } catch (eM0) {}
                    try {
                        ev.stopPropagation();
                    } catch (eM1) {}
                    if (topMoreMenuBtn.disabled || topMoreMenuBtn.getAttribute('aria-disabled') === 'true') {
                        return;
                    }
                    var nowOpen = topMoreWrap && topMoreWrap.classList.contains('is-open');
                    setTopMoreMenuOpen(!nowOpen);
                });
                syncTopMoreMenuAccess();
                /* 角色可能晚到：短轮询补同步（与 range-finder 调试按钮策略一致） */
                var topMoreAccessPollCount = 0;
                var topMoreAccessPollTimer = setInterval(function () {
                    topMoreAccessPollCount++;
                    syncTopMoreMenuAccess();
                    if (topMoreAccessPollCount >= 5) {
                        clearInterval(topMoreAccessPollTimer);
                        topMoreAccessPollTimer = null;
                    }
                }, 1000);
            }
            /* 设置弹窗 */
            var topMoreSettings = document.getElementById('topMoreSettings');
            var settingsModalOverlay = document.getElementById('settingsModalOverlay');
            var settingsModalCloseBtn = document.getElementById('settingsModalCloseBtn');
            var settingsGridEl = document.getElementById('settingsGrid');
            var settingsGridApi = null;
            var settingsStatus = document.getElementById('settingsStatus');

            function getSettingsUserId() {
                var u = window.__LENG_USER && window.__LENG_USER.user_id;
                if (u) return u;
                try {
                    var raw = localStorage.getItem('leng_user');
                    if (raw) {
                        var parsed = JSON.parse(raw);
                        if (parsed && parsed.user_id) return parsed.user_id;
                    }
                } catch (eL) {}
                return 'anonymous';
            }

            function getSettingsRowData() {
                return [
                    { field: 'snapshotTopBar', desc: '顶端行裁剪高度', value: 60, unit: 'px' },
                    { field: 'snapshotBottomDock', desc: '底部 Dock 裁剪高度', value: 50, unit: 'px' },
                    { field: 'snapInterval', desc: '快照刷新间隔', value: 5, unit: '秒' },
                    { field: 'binaryThreshold', desc: '二值化固定阈值', value: 140, unit: '' },
                ];
            }

            function buildSettingsGrid(data) {
                var rowData = getSettingsRowData();
                var s = data && data.success && data.settings ? data.settings : null;
                for (var i = 0; i < rowData.length; i++) {
                    var r = rowData[i];
                    if (s && s[r.field] != null) r.value = s[r.field];
                }
                var colDefs = [
                    {
                        headerName: '描述',
                        field: 'desc',
                        width: 170,
                        minWidth: 120,
                        resizable: true,
                        cellClass: 'settings-cell-desc',
                        editable: false,
                    },
                    {
                        headerName: '值',
                        field: 'value',
                        width: 220,
                        minWidth: 180,
                        resizable: true,
                        editable: true,
                        cellClass: 'settings-cell-value',
                        cellEditor: 'agTextCellEditor',
                        cellEditorParams: { useFormatter: true },
                        valueFormatter: function (p) { return p.value; },
                        valueParser: function (p) { return p.newValue; },
                        cellRendererSelector: function (params) {
                            return null;
                        },
                    },
                    {
                        headerName: '单位',
                        field: 'unit',
                        width: 80,
                        minWidth: 50,
                        resizable: true,
                        cellClass: 'settings-cell-unit',
                        editable: false,
                    },
                ];
                var gridOptions = {
                    columnDefs: colDefs,
                    rowData: rowData,
                    rowHeight: 38,
                    headerHeight: 32,
                    domLayout: 'normal',
                    stopEditingWhenCellsLoseFocus: true,
                    singleClickEdit: true,
                    onCellValueChanged: function () {
                        settingsStatus.textContent = '';
                        settingsStatus.className = 'settings-status';
                    },
                    components: {},
                };
                if (settingsGridApi) {
                    settingsGridApi.setGridOption('rowData', rowData);
                } else {
                    settingsGridApi = agGrid.createGrid(settingsGridEl, gridOptions);
                }
            }

            function loadSettings() {
                var uid = getSettingsUserId();
                settingsStatus.textContent = '加载中…';
                settingsStatus.className = 'settings-status';
                fetch('/api/user-settings?user_id=' + encodeURIComponent(uid))
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data && data.success && data.settings) {
                            buildSettingsGrid(data);
                            settingsStatus.textContent = '';
                            settingsStatus.className = 'settings-status';
                            try { localStorage.setItem('leng_user_settings', JSON.stringify(data.settings)); } catch (eLs) {}
                        } else {
                            buildSettingsGrid(null);
                            settingsStatus.textContent = '加载失败，使用默认值';
                            settingsStatus.className = 'settings-status settings-status--err';
                        }
                    })
                    .catch(function () {
                        buildSettingsGrid(null);
                        settingsStatus.textContent = '加载失败，使用默认值';
                        settingsStatus.className = 'settings-status settings-status--err';
                    });
            }

            function saveSettings() {
                if (!settingsGridApi) return;
                var uid = getSettingsUserId();
                var rowData = [];
                settingsGridApi.forEachNode(function (node) { rowData.push(node.data); });
                var topBar = 60, bottomDock = 50, snapInterval = 5, binaryThreshold = 140;
                for (var i = 0; i < rowData.length; i++) {
                    var r = rowData[i];
                    var v = parseInt(r.value, 10);
                    if (r.field === 'snapshotTopBar') topBar = isNaN(v) || v < 0 ? 60 : v;
                    else if (r.field === 'snapshotBottomDock') bottomDock = isNaN(v) || v < 0 ? 50 : v;
                    else if (r.field === 'snapInterval') {
                        var fv = parseFloat(r.value);
                        snapInterval = isNaN(fv) || fv <= 0 ? 5 : fv;
                        if (snapInterval > 60) snapInterval = 60;
                    } else if (r.field === 'binaryThreshold') {
                        binaryThreshold = isNaN(v) || v < 1 ? 140 : v;
                        if (binaryThreshold > 254) binaryThreshold = 254;
                    }
                }
                settingsStatus.textContent = '保存中…';
                settingsStatus.className = 'settings-status';
                fetch('/api/user-settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: uid,
                        settings: {
                            snapshotTopBar: topBar,
                            snapshotBottomDock: bottomDock,
                            snapInterval: snapInterval,
                            binaryThreshold: binaryThreshold,
                        },
                    }),
                })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data && data.success) {
                            var s = { snapshotTopBar: topBar, snapshotBottomDock: bottomDock, snapInterval: snapInterval, binaryThreshold: binaryThreshold };
                            if (window.__LENG_SETTINGS) {
                                window.__LENG_SETTINGS.snapshotTopBar = topBar;
                                window.__LENG_SETTINGS.snapshotBottomDock = bottomDock;
                                window.__LENG_SETTINGS.snapInterval = snapInterval;
                                window.__LENG_SETTINGS.binaryThreshold = binaryThreshold;
                            }
                            if (window.__screenDetector) {
                                window.__screenDetector.BINARY_THRESHOLD = binaryThreshold;
                            }
                            try { localStorage.setItem('leng_user_settings', JSON.stringify(s)); } catch (eLs) {}
                            if (settingsModalOverlay && settingsModalOverlay.classList.contains('show')) {
                                closeSettingsModal();
                            }
                        } else {
                            settingsStatus.textContent = '保存失败：' + (data && data.error ? data.error : '未知错误');
                            settingsStatus.className = 'settings-status settings-status--err';
                        }
                    })
                    .catch(function (err) {
                        settingsStatus.textContent = '保存失败：' + String(err);
                        settingsStatus.className = 'settings-status settings-status--err';
                    });
            }

            function openSettingsModal() {
                if (!settingsModalOverlay) return;
                settingsModalOverlay.setAttribute('aria-hidden', 'false');
                settingsModalOverlay.classList.add('show');
                loadSettings();
            }

            function closeSettingsModal() {
                if (!settingsModalOverlay) return;
                settingsModalOverlay.setAttribute('aria-hidden', 'true');
                settingsModalOverlay.classList.remove('show');
                saveSettings();
            }

            if (topMoreDigitTpl) {
                topMoreDigitTpl.addEventListener('click', function () {
                    closeTopMoreMenu();
                    openDigitTplModal();
                });
            }
            if (topMoreSettings) {
                topMoreSettings.addEventListener('click', function () {
                    closeTopMoreMenu();
                    openSettingsModal();
                });
            }
            if (settingsModalCloseBtn) {
                settingsModalCloseBtn.addEventListener('click', closeSettingsModal);
            }
            if (settingsModalOverlay) {
                settingsModalOverlay.addEventListener('click', function (ev) {
                    if (ev.target === settingsModalOverlay) closeSettingsModal();
                });
            }
            document.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape' && settingsModalOverlay && settingsModalOverlay.classList.contains('show')) {
                    closeSettingsModal();
                }
            });

            /* 截屏悬浮窗 - 浏览器悬浮窗 — 功能已移至 snap-float-driver.js */

            document.addEventListener(
                'click',
                function (ev) {
                    if (!topMoreWrap || !topMoreWrap.classList.contains('is-open')) return;
                    var t = ev.target;
                    if (t && typeof topMoreWrap.contains === 'function' && topMoreWrap.contains(t)) return;
                    closeTopMoreMenu();
                },
                false
            );
            document.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape') closeTopMoreMenu();
            });
            if (topNavNewRegister) {
                topNavNewRegister.addEventListener('click', function () {
                    openNewUserRegisterPanel();
                });
            }
            function userListModalUnlockBodyScroll() {
                document.body.style.overflow = userListModalBodyOverflowPrev;
            }

            function closeUserListModal() {
                userListModalUnlockBodyScroll();
                if (userListModalOverlay) {
                    userListModalOverlay.classList.remove('show');
                    userListModalOverlay.setAttribute('aria-hidden', 'true');
                }
            }

            function listKvUsersUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/list-kv-users'
                    : (apiBase || '') + '/api/list-kv-users';
            }

            function deleteKvUserApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/delete-kv-user'
                    : (apiBase || '') + '/api/delete-kv-user';
            }

            function rebuildGroupIndexApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/rebuild-group-index'
                    : (apiBase || '') + '/api/rebuild-group-index';
            }

            function refreshGroupInviteCodesApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/refresh-group-invite-codes'
                    : (apiBase || '') + '/api/refresh-group-invite-codes';
            }

            function avatarSaveApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/avatar-save'
                    : (apiBase || '') + '/api/avatar-save';
            }

            function avatarListApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/avatar-list'
                    : (apiBase || '') + '/api/avatar-list';
            }

            function sendEmailCodeApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/send-email-code'
                    : (apiBase || '') + '/api/send-email-code';
            }

            function checkUserApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/check-user'
                    : (apiBase || '') + '/api/check-user';
            }

            function envCheckApiUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/env-check'
                    : (apiBase || '') + '/api/env-check';
            }


            /** KV 原始头像字段 + D1 customs 快照：与 check-user / update-kv-profile 的 avatar_diagnostics 对齐 */
            function emitAvatarDiagnosticsToDebugDock(phaseLabel, diag) {
                if (!window.ENABLE_AVATAR_DEBUG_TO_DOCK) return;
                var title = String(phaseLabel == null ? '' : phaseLabel).trim() || '阶段';
                var dbgCode = avatarDiagDbgCode(title);
                var trunc = function (s, max) {
                    var t = String(s == null ? '' : s);
                    var m = max != null ? Number(max) : 220;
                    if (!isFinite(m) || m < 8) m = 220;
                    if (t.length <= m) return t;
                    return t.slice(0, m) + '…';
                };
                var avLine = function (body) {
                    window.loginDebugDockEmit('warn', window.dbgTagged(dbgCode, body));
                };
                var avErr = function (body) {
                    window.loginDebugDockEmit('error', window.dbgTagged(dbgCode, body));
                };
                /* 使用 loginDebugDockEmit（appendLineForce），勿用裸 console.info，否则易受「调试暂停」与 info 白名单影响 */
                try {
                    var rawBrief =
                        diag && typeof diag === 'object'
                            ? JSON.stringify(diag).slice(0, 3800)
                            : String(diag);
                    if (rawBrief.length >= 3799) rawBrief += '…';
                    avLine('[头像诊断][' + title + '] 原始 JSON · ' + rawBrief);
                } catch (eCi) {}
                if (!diag || typeof diag !== 'object') {
                    avLine('[头像诊断·' + title + '] （服务端未返回 avatar_diagnostics）');
                    avLine('[头像诊断][' + title + '] avatar_diagnostics(JSON) (missing)');
                    return;
                }
                var D = diag;
                avLine('[头像诊断·' + title + '] —— KV 存值 / D1(customs) 探针');
                avLine(
                    '  uuid: ' +
                        (D.uuid || '(空)') +
                        ' | kv_has_uuid: ' +
                        (D.kv_has_uuid === true ? 'true' : 'false')
                );
                avLine(
                    '  D1 已配置: ' +
                        (D.d1_binding_configured === true ? '是' : '否') +
                        ' | customs 有对应行: ' +
                        (D.d1_customs_row_exists === true ? '是' : '否')
                );
                avLine('  D1 最新 r2_key: ' + trunc(D.d1_latest_r2_key || '(无)', 260));
                avLine(
                    '  由 r2_key 推导媒体 URL: ' +
                        trunc(D.deduced_media_url_from_d1_key || '(无)', 260)
                );
                avLine('  KV.avatar_url: ' + trunc(D.kv_avatar_url_stored || '(空)', 260));
                avLine('  KV.avatar_r2_key: ' + trunc(D.kv_avatar_r2_key_stored || '(空)', 260));
                if (D.kv_has_avatar_data_url === true) {
                    avLine('  KV 另含 avatar_data_url（内嵌图存在，未在日志中展开）');
                }
                if (
                    D.d1_created_at_ms != null &&
                    D.d1_created_at_ms !== '' &&
                    Number(D.d1_created_at_ms) > 0
                ) {
                    avLine('  D1 行 created_at(ms): ' + String(D.d1_created_at_ms));
                }
                if (D.probe_error != null && String(D.probe_error).trim() !== '') {
                    avErr('  探针备注/错误: ' + trunc(String(D.probe_error), 400));
                }
                try {
                    var jsonStr = JSON.stringify(D);
                    if (jsonStr.length > 4500) {
                        jsonStr = jsonStr.slice(0, 4500) + '…';
                    }
                    avLine('[头像诊断][' + title + '] avatar_diagnostics(JSON) ' + jsonStr);
                } catch (_eJson) {}
            }
            window.emitAvatarDiagnosticsToDebugDock = emitAvatarDiagnosticsToDebugDock;

            /** 密码登录故障时拉取 env-check，写入调试面板（并自动展开） */
            async function fetchEnvCheckSnapshotToDebugDock(reason) {
                var why = String(reason || 'login').trim() || 'login';
                try {
                    var url = envCheckApiUrl();
                    var r = await fetch(url, { cache: 'no-store' });
                    var txt = await r.text();
                    var j = null;
                    try {
                        j = txt ? JSON.parse(txt) : null;
                    } catch (e1) {
                        j = null;
                    }
                    var payload =
                        j && typeof j === 'object'
                            ? j
                            : { parse_error: true, http: r.status, snippet: String(txt || '').slice(0, 400) };
                    var line = window.dbgTagged(
                        window.DBG_A0001,
                        '[密码登录] ' +
                            why +
                            ' → GET env-check HTTP ' +
                            r.status +
                            ' ' +
                            JSON.stringify(payload)
                    );
                    window.loginDebugDockEmit(r.ok ? 'warn' : 'error', line);
                } catch (e2) {
                    var fail = window.dbgTagged(
                        window.DBG_A0001,
                        '[密码登录] ' +
                            why +
                            ' → env-check 请求失败 ' +
                            String((e2 && e2.message) || e2 || '')
                    );
                    window.loginDebugDockEmit('error', fail);
                }
            }

            function sleepMs(ms) {
                return new Promise(function (resolve) {
                    setTimeout(resolve, Math.max(0, Number(ms) || 0));
                });
            }

            async function requestCheckUserWithDiagnostics(payload) {
                var maxAttempts = 6;
                var attempts = 0;
                var lastErr = null;
                var hint503 = '';
                var startedAt = Date.now();
                var maxTotalMs = 52000;
                var perTryTimeoutMs = 22000;
                while (attempts < maxAttempts) {
                    if (Date.now() - startedAt > maxTotalMs) {
                        throw new Error('登录请求超时，请稍后重试');
                    }
                    attempts++;
                    try {
                        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                        var timer = null;
                        try {
                            if (ctrl) {
                                timer = setTimeout(function () {
                                    try {
                                        ctrl.abort();
                                    } catch (eAbort) {}
                                }, perTryTimeoutMs);
                            }
                            var response = await fetch(checkUserApiUrl(), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload || {}),
                                cache: 'no-store',
                                signal: ctrl ? ctrl.signal : undefined
                            });
                        } finally {
                            if (timer) clearTimeout(timer);
                        }
                        var text = await response.text();
                        var data = null;
                        if (text) {
                            try {
                                data = JSON.parse(text);
                            } catch (e) {}
                        }
                        if (response.ok) {
                            var elapsedOk = Date.now() - startedAt;
                            return {
                                ok: true,
                                data: data || {},
                                status: response.status,
                                attempts: attempts,
                                elapsedMs: elapsedOk
                            };
                        }
                        var st = Number(response.status);
                        var msg =
                            (data && (data.error || data.msg)) ||
                            ('HTTP ' + String(response.status || '错误'));
                        if (st === 501 || /Unsupported method/i.test(String(text || ''))) {
                            msg =
                                'HTTP ' +
                                st +
                                '：当前是本地静态服务，不支持 POST /api/check-user。请部署到 Cloudflare Pages（或用 wrangler pages dev）后再测密码登录。';
                        } else if (!data && text && /<!DOCTYPE|<html/i.test(text)) {
                            msg =
                                'HTTP ' +
                                st +
                                '：接口返回了网页而不是 JSON，说明 /api/check-user 未生效。';
                        }
                        if (st === 503 && !hint503 && attempts <= 2) {
                            try {
                                var er = await fetch(envCheckApiUrl(), { cache: 'no-store' });
                                var ej = await er.json().catch(function () { return {}; });
                                if (ej && ej.success === true) {
                                    if (ej.has_my_kv === false) {
                                        hint503 = '（检测到 my_kv 未绑定）';
                                    } else if (ej.has_my_kv === true) {
                                        hint503 = '（my_kv 已绑定，多为边缘/KV 瞬时过载，将自动重试）';
                                    }
                                }
                            } catch (e2) {}
                        }
                        if (st === 503) {
                            msg = 'HTTP 503 ' + (hint503 || '');
                        }
                        lastErr = new Error(msg);
                        var retriable =
                            st === 503 ||
                            st === 502 ||
                            st === 429 ||
                            st === 524 ||
                            st === 530 ||
                            st === 525;
                        if (retriable && attempts < maxAttempts) {
                            if (Date.now() - startedAt > maxTotalMs - 900) {
                                throw new Error('登录请求超时，请稍后重试');
                            }
                            var base =
                                attempts === 1
                                    ? 280
                                    : attempts === 2
                                      ? 650
                                      : attempts === 3
                                        ? 1200
                                        : attempts === 4
                                          ? 1800
                                          : 2300;
                            var waitMs = base + Math.floor(Math.random() * 180);
                            await sleepMs(waitMs);
                            continue;
                        }
                        throw lastErr;
                    } catch (err) {
                        var msg = String((err && err.message) || err || '网络异常');
                        if (msg === 'The operation was aborted.' || msg === 'AbortError') {
                            msg = '登录请求超时，请稍后重试';
                        }
                        lastErr = new Error(msg);
                        if (attempts < maxAttempts) {
                            if (Date.now() - startedAt > maxTotalMs - 700) {
                                throw lastErr;
                            }
                            var waitMs2 =
                                (attempts === 1 ? 320 : attempts === 2 ? 780 : attempts === 3 ? 1200 : 1600) +
                                Math.floor(Math.random() * 220);
                            await sleepMs(waitMs2);
                            continue;
                        }
                        throw lastErr;
                    }
                }
                throw lastErr || new Error('网络异常');
            }

            function userListValueFromRow(row) {
                var prev = row && row._valueRaw && typeof row._valueRaw === 'object' ? row._valueRaw : {};
                var out = Object.assign({}, prev);
                if (row.name != null) out.name = String(row.name);
                if (row.email != null) out.email = String(row.email);
                if (row.group != null) out.group = String(row.group);
                out.g_role = Number(row.g_role) === 1 ? 1 : 0;
                if (row.uuid != null && String(row.uuid).trim() !== '') {
                    out.uuid = String(row.uuid).trim();
                } else if (!out.uuid || String(out.uuid).trim() === '') {
                    if (prev.uuid != null && String(prev.uuid).trim() !== '') {
                        out.uuid = String(prev.uuid).trim();
                    } else {
                        out.uuid = '';
                    }
                }
                if (row.pwd != null && String(row.pwd).trim() !== '') {
                    out.pwd = String(row.pwd).trim();
                }
                if (row.pwd_hash != null && String(row.pwd_hash).trim() !== '') {
                    out.pwd_hash = String(row.pwd_hash).trim();
                }
                return out;
            }

            function userListMaskFieldToBin8(val) {
                if (val == null || val === '') {
                    return '00000000';
                }
                var s = String(val).trim();
                if (/^[01]+$/.test(s)) {
                    return (s.length > 8 ? s.slice(-8) : s.padStart(8, '0'));
                }
                var n = parseInt(s, 10);
                if (isNaN(n)) {
                    n = 0;
                }
                return ((n >>> 0) & 255).toString(2).padStart(8, '0');
            }

            /** 仅提交表格可编辑字段；与 KV 合并由服务端完成，避免请求体过大或误覆盖 */
            function userListMetaFromRow(row) {
                return {
                    status: Number(row.status) || 0,
                    type: /^[01]+$/.test(String(row.type || ''))
                        ? String(row.type)
                        : Number(row.type || 0).toString(2).padStart(8, '0'),
                    uA_perms: /^[01]+$/.test(String(row.uA_perms || ''))
                        ? String(row.uA_perms)
                        : Number(row.uA_perms || 0).toString(2).padStart(8, '0'),
                    uA_act_perms: /^[01]+$/.test(String(row.uA_act_perms || ''))
                        ? String(row.uA_act_perms)
                        : Number(row.uA_act_perms || 0).toString(2).padStart(8, '0'),
                    stfA_perms_can_ban_post: Number(row.stfA_perms_can_ban_post) || 0,
                    uA_Tier: Number(row.uA_Tier) || 0,
                    uB_Tier: Number(row.uB_Tier) || 0,
                    uC_Tier: userListMaskFieldToBin8(row.uC_Tier),
                    uC_EType: userListMaskFieldToBin8(row.uC_EType)
                };
            }

            function updateKvProfileUrl() {
                var apiBase =
                    window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                        ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                        : '';
                return window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                    ? '/api/update-kv-profile'
                    : (apiBase || '') + '/api/update-kv-profile';
            }

            function saveUserListRowToKv(row) {
                if (!row || !row.key) return Promise.resolve();
                var payload = {
                    key: row.key,
                    value: userListValueFromRow(row),
                    metadata: userListMetaFromRow(row)
                };
                return fetch(updateKvProfileUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(function (r) {
                    return r.text().then(function (text) {
                        var j = null;
                        if (text) {
                            try {
                                j = JSON.parse(text);
                            } catch (e) {}
                        }
                        if (!r.ok || !j || j.success !== true) {
                            var msg =
                                (j && (j.error || j.msg)) ||
                                ('HTTP ' + (r.status != null ? r.status : '错误'));
                            throw new Error(msg);
                        }
                        if (j.value != null && typeof j.value === 'object') {
                            row._valueRaw = j.value;
                        } else {
                            row._valueRaw = payload.value;
                        }
                        if (j.metadata != null && typeof j.metadata === 'object') {
                            row._metaRaw = j.metadata;
                        } else {
                            row._metaRaw = payload.metadata;
                        }
                    });
                });
            }

            function userListParseRowTypeBits(r) {
                var s = String(r && r.type != null ? r.type : '').trim();
                if (/^[01]+$/.test(s)) {
                    return parseInt(s, 2) || 0;
                }
                return parseInt(s, 10) || 0;
            }

            function userListParseRowCTierBits(r) {
                var v = r && r.uC_Tier;
                var s = String(v == null ? '' : v).trim();
                if (/^[01]+$/.test(s)) {
                    return parseInt(s, 2) || 0;
                }
                var n = Number(v);
                return isNaN(n) ? 0 : n;
            }

            function userManageTreeNodeSetLabel(btn, text) {
                if (!btn) return;
                btn.innerHTML = '';
                var span = document.createElement('span');
                span.className = 'user-manage-tree-node-label';
                span.textContent = text;
                btn.appendChild(span);
            }

            function userManageGroupTreeLabelForGroup(gval) {
                var inv = normalizeInviteSixDigits(window.userManageGroupInviteCodeCache[gval] || '');
                return inv ? gval + '组(' + inv + ')' : gval + '组';
            }

            function userManageFetchTreeInviteCodesForGroups(groupIds) {
                if (!groupIds || !groupIds.length) return Promise.resolve();
                var base = groupInviteCodeApiUrl();
                return Promise.all(
                    groupIds.map(function (g) {
                        return fetch(base + '?group=' + encodeURIComponent(g), {
                            method: 'GET',
                            cache: 'no-store'
                        })
                            .then(function (r) {
                                return r.text().then(function (text) {
                                    var j = null;
                                    if (text) {
                                        try {
                                            j = JSON.parse(text);
                                        } catch (e) {}
                                    }
                                    return { ok: r.ok, j: j, g: g };
                                });
                            })
                            .then(function (x) {
                                var code = '';
                                if (x.ok && x.j && x.j.success === true && x.j.code != null) {
                                    code = normalizeInviteSixDigits(String(x.j.code)) || '';
                                }
                                window.userManageGroupInviteCodeCache[x.g] = code;
                            })
                            .catch(function () {
                                window.userManageGroupInviteCodeCache[g] = '';
                            });
                    })
                ).then(function () {
                    if (userManageGroupTree) {
                        renderUserManageGroupTree(userListAllRowsCache);
                    }
                });
            }

            function renderUserManageGroupTree(rows) {
                if (!userManageGroupTree) return;
                var allRows = Array.isArray(rows) ? rows : [];
                var gset = new Set();
                for (var i = 0; i < allRows.length; i++) {
                    var gtxt = String(allRows[i] && allRows[i].group != null ? allRows[i].group : '').trim();
                    var gn = parseInt(gtxt, 10);
                    if (!isNaN(gn) && gn >= 70 && gn <= 200) {
                        gset.add(String(gn));
                    }
                }
                userManageGroupTree.innerHTML = '';

                function createSection(key, title) {
                    var sec = document.createElement('div');
                    sec.className = 'user-manage-tree-section';
                    var toggle = document.createElement('button');
                    toggle.type = 'button';
                    toggle.className = 'user-manage-tree-section-toggle' + (userManageTreeCollapsed[key] ? ' is-collapsed' : '');
                    toggle.textContent = title;
                    toggle.addEventListener('click', function () {
                        userManageTreeCollapsed[key] = !userManageTreeCollapsed[key];
                        renderUserManageGroupTree(userListAllRowsCache);
                    });
                    sec.appendChild(toggle);
                    var children = document.createElement('div');
                    children.className = 'user-manage-tree-children';
                    if (userManageTreeCollapsed[key]) children.setAttribute('hidden', '');
                    sec.appendChild(children);
                    userManageGroupTree.appendChild(sec);
                    return children;
                }

                function addNode(container, gval) {
                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'user-manage-tree-node' + (userManageSelectedGroup === gval ? ' is-active' : '');
                    userManageTreeNodeSetLabel(btn, userManageGroupTreeLabelForGroup(gval));
                    btn.addEventListener('click', function () {
                        userManageSelectedGroup = gval;
                        renderUserManageGroupTree(userListAllRowsCache);
                        userListApplyTopFilters();
                    });
                    container.appendChild(btn);
                }

                var allBtn = document.createElement('button');
                allBtn.type = 'button';
                allBtn.className =
                    'user-manage-tree-node' +
                    (userManageSelectedGroup === '' || userManageSelectedGroup == null ? ' is-active' : '');
                userManageTreeNodeSetLabel(allBtn, '全部');
                allBtn.addEventListener('click', function () {
                    userManageSelectedGroup = '';
                    renderUserManageGroupTree(userListAllRowsCache);
                    userListApplyTopFilters();
                });
                userManageGroupTree.appendChild(allBtn);

                var groupChildren = createSection('groups', '组别');
                var count = 0;
                for (var g = 70; g <= 200; g++) {
                    var key = String(g);
                    if (!gset.has(key)) continue;
                    addNode(groupChildren, key);
                    count++;
                }
                if (!count) {
                    var em = document.createElement('div');
                    em.className = 'user-manage-tree-empty';
                    em.textContent = '暂无70-200组';
                    groupChildren.appendChild(em);
                }

                var needInviteFetch = [];
                for (var gf = 70; gf <= 200; gf++) {
                    var kf = String(gf);
                    if (!gset.has(kf)) continue;
                    if (window.userManageGroupInviteCodeCache[kf] === undefined) {
                        needInviteFetch.push(kf);
                    }
                }
                if (needInviteFetch.length) {
                    userManageFetchTreeInviteCodesForGroups(needInviteFetch);
                }
            }

            function userListGroupNumber(row) {
                var gtxt = String(row && row.group != null ? row.group : '').trim();
                var gn = parseInt(gtxt, 10);
                return isNaN(gn) ? Number.MAX_SAFE_INTEGER : gn;
            }

            function userListSortRowsByGroupAndLeader(rows) {
                return (Array.isArray(rows) ? rows.slice() : []).sort(function (a, b) {
                    var ga = userListGroupNumber(a);
                    var gb = userListGroupNumber(b);
                    if (ga !== gb) return ga - gb;
                    var la = Number(a && a.g_role) === 1 ? 1 : 0;
                    var lb = Number(b && b.g_role) === 1 ? 1 : 0;
                    if (la !== lb) return lb - la;
                    var ka = String(a && a.key != null ? a.key : '');
                    var kb = String(b && b.key != null ? b.key : '');
                    return ka.localeCompare(kb);
                });
            }

            /** 在「分组显示，整组折叠」勾选时，按组折叠/展开；未勾选则仅按组号与组长排序 */
            function userListApplyGroupCollapseIfNeeded(rows) {
                var collapseOn = !!(userManageCollapseGroupsCheckbox && userManageCollapseGroupsCheckbox.checked);
                var sorted = userListSortRowsByGroupAndLeader(rows);
                if (!collapseOn) return sorted;

                var buckets = new Map();
                for (var i = 0; i < sorted.length; i++) {
                    var r = sorted[i];
                    var g = String(r && r.group != null ? r.group : '').trim();
                    if (!buckets.has(g)) buckets.set(g, []);
                    buckets.get(g).push(r);
                }

                var keys = Array.from(buckets.keys());
                keys.sort(function (a, b) {
                    var na = parseInt(a, 10);
                    var nb = parseInt(b, 10);
                    var va = isNaN(na) ? Number.MAX_SAFE_INTEGER : na;
                    var vb = isNaN(nb) ? Number.MAX_SAFE_INTEGER : nb;
                    if (va !== vb) return va - vb;
                    return String(a).localeCompare(String(b));
                });

                var out = [];
                for (var ki = 0; ki < keys.length; ki++) {
                    var key = keys[ki];
                    var arr = buckets.get(key) || [];
                    if (!key) {
                        out = out.concat(arr);
                        continue;
                    }
                    if (userManageExpandedGroups[key]) {
                        out = out.concat(arr);
                        continue;
                    }
                    var leader = null;
                    for (var j = 0; j < arr.length; j++) {
                        if (Number(arr[j] && arr[j].g_role) === 1) {
                            leader = arr[j];
                            break;
                        }
                    }
                    out.push(leader || arr[0]);
                }
                return out;
            }

            function userListApplyTopFilters() {
                var showAll = userListShowAllCheckbox && userListShowAllCheckbox.checked;
                var rows;
                if (showAll) {
                    rows = userListAllRowsCache.slice();
                } else {
                    var typeMask = userListTypeFilterSelect ? parseInt(userListTypeFilterSelect.value, 10) || 0 : 0;
                    var cTierMask = userListCTierFilterSelect
                        ? parseInt(userListCTierFilterSelect.value, 10) || 0
                        : 0;
                    rows = [];
                    for (var i = 0; i < userListAllRowsCache.length; i++) {
                        var r = userListAllRowsCache[i];
                        var t = userListParseRowTypeBits(r);
                        if ((t & typeMask) === 0) {
                            continue;
                        }
                        var uc = userListParseRowCTierBits(r);
                        if ((uc & cTierMask) === 0) {
                            continue;
                        }
                        rows.push(r);
                    }
                }
                if (userManageSelectedGroup) {
                    rows = rows.filter(function (r) {
                        return String(r && r.group != null ? r.group : '').trim() === userManageSelectedGroup;
                    });
                }
                rows = userListApplyGroupCollapseIfNeeded(rows);
                if (window.UserListGrid && typeof UserListGrid.setRowData === 'function') {
                    UserListGrid.setRowData(rows);
                }
            }

            function userListSyncFilterCombosDisabled() {
                var allOn = !!(userListShowAllCheckbox && userListShowAllCheckbox.checked);
                if (userListTypeFilterSelect) {
                    userListTypeFilterSelect.disabled = allOn;
                }
                if (userListCTierFilterSelect) {
                    userListCTierFilterSelect.disabled = allOn;
                }
            }

            function loadUserListFromKv() {
                if (!window.UserListGrid || typeof UserListGrid.init !== 'function') {
                    alert('用户列表组件未加载。');
                    return;
                }
                if (typeof UserListGrid.buildRowFromKv !== 'function') {
                    alert('用户列表组件异常。');
                    return;
                }
                /** 判断当前用户角色，决定 API 参数 */
                var role = window.__currentUserRole || { type: 0, g_role: 0 };
                var isAdminMenuUnlocked = false;
                try { isAdminMenuUnlocked = sessionStorage.getItem('L_ENG_admin_menu_unlocked_v1') === '1'; } catch (_eAd) {}
                var isSuperUser = (role.type & 1) !== 0;
                var isDebugger = !isAdminMenuUnlocked && (role.type & 2) !== 0;
                var isLeader = !isAdminMenuUnlocked && !isSuperUser && !isDebugger && role.g_role === 1;
                var fetchUrl = listKvUsersUrl();
                if (isLeader) {
                    var myGroup = String(window.__currentUserGroup || '').trim();
                    fetchUrl += (fetchUrl.indexOf('?') >= 0 ? '&' : '?') + 'group=' + encodeURIComponent(myGroup);
                }
                fetch(fetchUrl, { method: 'GET', cache: 'no-store' })
                    .then(function (r) {
                        return r.text().then(function (text) {
                            var j = null;
                            if (text) {
                                try {
                                    j = JSON.parse(text);
                                } catch (e) {
                                    console.error('[list-kv-users] 非 JSON', text.slice(0, 400));
                                }
                            }
                            return { ok: r.ok, j: j, status: r.status };
                        });
                    })
                    .then(function (x) {
                        if (!x.ok || !x.j || x.j.success !== true || !Array.isArray(x.j.users)) {
                            var msg =
                                (x.j && (x.j.error || x.j.msg)) ||
                                ('HTTP ' + (x.status != null ? x.status : '错误'));
                            alert('加载用户列表失败：' + msg);
                            return;
                        }
                        var rows = [];
                        for (var i = 0; i < x.j.users.length; i++) {
                            var u = x.j.users[i];
                            if (!u || !u.key) continue;
                            try {
                                rows.push(
                                    UserListGrid.buildRowFromKv(u.key, u.value || {}, u.metadata || {})
                                );
                            } catch (e) {
                                console.warn('[list-kv-users] 跳过无效项', u.key, e);
                            }
                        }
                        /** 判断当前用户角色 */
                        var role = window.__currentUserRole || { type: 0, g_role: 0 };
                        var isAdminMenuUnlocked = false;
                        try { isAdminMenuUnlocked = sessionStorage.getItem('L_ENG_admin_menu_unlocked_v1') === '1'; } catch (_eAd) {}
                        var isSuperUser = (role.type & 1) !== 0;
                        var isDebugger = !isAdminMenuUnlocked && (role.type & 2) !== 0;
                        var isLeader = !isAdminMenuUnlocked && !isSuperUser && !isDebugger && role.g_role === 1;
                        /** 组长：只保留本组成员 */
                        if (isLeader) {
                            var myGroup = String(window.__currentUserGroup || '').trim();
                            var before = rows.length;
                            rows = rows.filter(function (r) {
                                return String(r && r.group != null ? r.group : '').trim() === myGroup;
                            });
                            console.log('[role] loadUserListFromKv 组长过滤', {
                                isLeader: isLeader,
                                myGroup: myGroup,
                                __currentUserGroup: window.__currentUserGroup,
                                __currentUserRole: window.__currentUserRole,
                                before: before,
                                after: rows.length,
                                sampleGroups: rows.slice(0, 3).map(function(r) { return r.group; })
                            });
                        }
                        /** 调试员：排除超级用户（type bit 1） */
                        if (isDebugger) {
                            rows = rows.filter(function (r) {
                                return (userListParseRowTypeBits(r) & 1) === 0;
                            });
                        }
                        userListAllRowsCache = rows.slice();
                        userManageExpandedGroups = {};
                        window.userManageGroupInviteCodeCache = Object.create(null);
                        renderUserManageGroupTree(userListAllRowsCache);
                        /** 组长模式：精简列 + 只读 + 无删除 */
                        if (isLeader && typeof UserListGrid.createLeaderColumnDefs === 'function') {
                            UserListGrid.init({
                                gridElementId: 'userListModalGrid',
                                scrollSectionId: 'userListModalScrollSection',
                                initialRows: [],
                                appendScrollsIntoView: false,
                                columnDefs: UserListGrid.createLeaderColumnDefs(),
                                gridOptions: {
                                    rowSelection: 'single'
                                }
                            });
                        } else {
                            UserListGrid.init({
                                gridElementId: 'userListModalGrid',
                                scrollSectionId: 'userListModalScrollSection',
                                initialRows: [],
                                appendScrollsIntoView: false,
                                getDeleteKvUserUrl: deleteKvUserApiUrl,
                                gridOptions: {
                                    rowSelection: 'single',
                                    onCellValueChanged: function (evt) {
                                        var row = evt && evt.data;
                                        if (!row || !row.key) return;
                                        var rk = row.key;
                                        if (userListSaveDebounceByKey[rk]) {
                                            clearTimeout(userListSaveDebounceByKey[rk]);
                                        }
                                        userListSaveDebounceByKey[rk] = setTimeout(function () {
                                            userListSaveDebounceByKey[rk] = null;
                                            saveUserListRowToKv(row).catch(function (e) {
                                                console.error('[user-list] 保存失败', e);
                                                alert('用户列表保存失败：' + String(e.message || e));
                                            });
                                        }, 450);
                                    },
                                    onRowClicked: function (evt) {
                                        if (!userManageCollapseGroupsCheckbox || !userManageCollapseGroupsCheckbox.checked) return;
                                        var row = evt && evt.data;
                                        if (!row || Number(row.g_role) !== 1) return;
                                        var grp = String(row.group != null ? row.group : '').trim();
                                        if (!grp) return;
                                        userManageExpandedGroups[grp] = !userManageExpandedGroups[grp];
                                        userListApplyTopFilters();
                                    }
                                }
                            });
                        }
                        userListApplyTopFilters();
                    })
                    .catch(function (err) {
                        console.error(err);
                        alert('加载用户列表失败：网络异常');
                    });
            }

            function openUserListModal() {
                if (!userListModalOverlay) return;
                userListModalBodyOverflowPrev = document.body.style.overflow || '';
                document.body.style.overflow = 'hidden';
                userListModalOverlay.classList.add('show');
                userListModalOverlay.setAttribute('aria-hidden', 'false');
                /** 组长模式：隐藏超管专用 UI（超级用户/调试技术员不隐藏） */
                var role = window.__currentUserRole || { type: 0, g_role: 0 };
                var isAdminMenuUnlocked = false;
                try { isAdminMenuUnlocked = sessionStorage.getItem('L_ENG_admin_menu_unlocked_v1') === '1'; } catch (_eA) {}
                var isSuperUser = (role.type & 1) !== 0;
                var isDebugger = !isAdminMenuUnlocked && (role.type & 2) !== 0;
                var isLeader = !isAdminMenuUnlocked && !isSuperUser && !isDebugger && role.g_role === 1;
                applyUserListLeaderUI(isLeader);
                if (!isLeader) {
                    if (userListSearchPhoneInput) userListSearchPhoneInput.value = '';
                    if (userListShowAllCheckbox) userListShowAllCheckbox.checked = true;
                    userListSyncFilterCombosDisabled();
                    syncUserListDefaultRegisterGroupPanel();
                }
                loadUserListFromKv();
            }

            /** 组长模式：隐藏超管专用 UI 元素 */
            function applyUserListLeaderUI(isLeader) {
                /** 搜索、筛选、操作按钮、默认组、树形面板这些 DOM 元素 */
                var leaderHideIds = [
                    'userListSearchPhoneInput', 'userListTypeFilterSelect', 'userListCTierFilterSelect',
                    'userListShowAllCheckbox', 'userListRebuildGroupIndexBtn', 'userListRefreshGroupInviteCodesBtn',
                    'userListDefaultRegisterGroupInput', 'userListDefaultRegisterGroupSaveBtn',
                    'userListDefaultRegisterGroupClearBtn', 'userListInviteLinkHint',
                    'userManageGroupTree', 'userManageCollapseGroupsCheckbox'
                ];
                /** 这些元素的父级容器（search 行、filter 行等）也需要隐藏 */
                var leaderHideContainers = [];
                if (window.userListSearchPhoneInput) leaderHideContainers.push(window.userListSearchPhoneInput.closest('.user-list-modal-search'));
                if (window.userListTypeFilterSelect) leaderHideContainers.push(window.userListTypeFilterSelect.closest('.user-list-modal-search'));
                if (window.userListCTierFilterSelect) leaderHideContainers.push(window.userListCTierFilterSelect.closest('.user-list-modal-search'));
                if (window.userListDefaultRegisterGroupInput) leaderHideContainers.push(window.userListDefaultRegisterGroupInput.closest('.user-list-default-group-row'));
                if (window.userManageGroupTree) leaderHideContainers.push(window.userManageGroupTree.closest('.user-manage-tree-column'));
                var show = !isLeader;
                for (var i = 0; i < leaderHideIds.length; i++) {
                    var el = document.getElementById(leaderHideIds[i]);
                    if (el) {
                        if (show) { el.removeAttribute('hidden'); el.style.display = ''; }
                        else { el.setAttribute('hidden', ''); el.style.display = 'none'; }
                    }
                }
                for (var j = 0; j < leaderHideContainers.length; j++) {
                    var ct = leaderHideContainers[j];
                    if (ct) {
                        if (show) { ct.removeAttribute('hidden'); ct.style.display = ''; }
                        else { ct.setAttribute('hidden', ''); ct.style.display = 'none'; }
                    }
                }
                /** 标签元素（搜索 label、筛选 label 等） */
                var labels = document.querySelectorAll('.user-list-modal-search-label, .user-list-show-all-label');
                for (var k = 0; k < labels.length; k++) {
                    if (show) { labels[k].removeAttribute('hidden'); labels[k].style.display = ''; }
                    else { labels[k].setAttribute('hidden', ''); labels[k].style.display = 'none'; }
                }
                /** 分组折叠 checkbox 及其 label */
                if (window.userManageCollapseGroupsCheckbox) {
                    var cbLabel = window.userManageCollapseGroupsCheckbox.closest('label');
                    if (cbLabel) {
                        if (show) { cbLabel.removeAttribute('hidden'); cbLabel.style.display = ''; }
                        else { cbLabel.setAttribute('hidden', ''); cbLabel.style.display = 'none'; }
                    }
                }
                /** 树形底部 footer */
                var treeFooter = document.querySelector('.user-manage-tree-footer');
                if (treeFooter) {
                    if (show) { treeFooter.removeAttribute('hidden'); treeFooter.style.display = ''; }
                    else { treeFooter.setAttribute('hidden', ''); treeFooter.style.display = 'none'; }
                }
                /** 组长模式：取消「分组显示，整组折叠」勾选，避免只展示一组时被折叠隐藏 */
                if (window.userManageCollapseGroupsCheckbox) {
                    if (isLeader) {
                        window.userManageCollapseGroupsCheckbox.checked = false;
                    }
                }
            }

            function avatarSavedNormalizeEntry(entry) {
                if (typeof entry === 'string') {
                    return {
                        dataUrl: entry,
                        is_bg: 1
                    };
                }
                if (!entry || typeof entry !== 'object' || !entry.dataUrl) {
                    return null;
                }
                return {
                    dataUrl: String(entry.dataUrl),
                    is_bg: entry.is_bg === 0 ? 0 : 1
                };
            }
            window.avatarSavedNormalizeEntry = avatarSavedNormalizeEntry;

            function avatarManageResetPreview() {
                avatarManagePendingThumbDataUrl = '';
                avatarManagePendingIsRound = false;
                window.avatarManageSelectedSaved = null;
                if (avatarManagePreviewImg) {
                    avatarManagePreviewImg.removeAttribute('src');
                    avatarManagePreviewImg.style.display = 'none';
                    avatarManagePreviewImg.classList.remove('is-round', 'is-rect');
                }
                if (avatarManagePlaceholder) {
                    avatarManagePlaceholder.style.display = '';
                }
                if (avatarManageIsBgCheckbox) {
                    avatarManageIsBgCheckbox.checked = true;
                }
                avatarSavedRenderAll();
                avatarManageSyncButtons();
            }

            function avatarManageSyncButtons() {
                if (avatarManageSaveBtn) {
                    avatarManageSaveBtn.disabled = !avatarManagePendingThumbDataUrl;
                }
                if (avatarManageDeleteBtn) {
                    avatarManageDeleteBtn.disabled = !window.avatarManageSelectedSaved;
                }
            }

            function avatarSavedSetSelected(shape, index) {
                if (!shape || index == null || index < 0) {
                    window.avatarManageSelectedSaved = null;
                    if (avatarManagePreviewImg) {
                        avatarManagePreviewImg.removeAttribute('src');
                        avatarManagePreviewImg.style.display = 'none';
                        avatarManagePreviewImg.classList.remove('is-round', 'is-rect');
                    }
                    if (avatarManagePlaceholder) {
                        avatarManagePlaceholder.style.display = '';
                    }
                } else {
                    var list = shape === 'round' ? avatarSavedRoundList : avatarSavedSquareList;
                    var item = list && list[index] ? avatarSavedNormalizeEntry(list[index]) : null;
                    if (!item) {
                        window.avatarManageSelectedSaved = null;
                    } else {
                        window.avatarManageSelectedSaved = {
                            shape: shape,
                            index: index
                        };
                        if (avatarManagePreviewImg) {
                            avatarManagePreviewImg.src = item.dataUrl;
                            avatarManagePreviewImg.style.display = 'block';
                            avatarManagePreviewImg.classList.remove('is-round', 'is-rect');
                            avatarManagePreviewImg.classList.add(shape === 'round' ? 'is-round' : 'is-rect');
                        }
                        if (avatarManagePlaceholder) {
                            avatarManagePlaceholder.style.display = 'none';
                        }
                        if (avatarManageIsBgCheckbox) {
                            avatarManageIsBgCheckbox.checked = item.is_bg === 1;
                        }
                    }
                    avatarManagePendingThumbDataUrl = '';
                    avatarManagePendingIsRound = false;
                }
                avatarSavedRenderAll();
                avatarManageSyncButtons();
            }

            function avatarSavedPersist() {
                try {
                    localStorage.setItem(
                        AVATAR_MANAGE_SAVED_KEY,
                        JSON.stringify({
                            round: avatarSavedRoundList.slice(0, 30),
                            square: avatarSavedSquareList.slice(0, 30)
                        })
                    );
                } catch (e) {}
            }

            /** 兜底：避免头像库被清空后「圆型/方型」都显示暂无。 */
            function avatarSavedEnsureSeedDefaults() {
                if ((avatarSavedRoundList && avatarSavedRoundList.length) || (avatarSavedSquareList && avatarSavedSquareList.length)) {
                    return false;
                }
                var seed = {
                    dataUrl: '/icons/avatar-home-fallback.png',
                    is_bg: 1
                };
                avatarSavedRoundList = [seed];
                avatarSavedSquareList = [seed];
                avatarSavedPersist();
                return true;
            }

            function avatarSavedLoad() {
                try {
                    var raw = localStorage.getItem(AVATAR_MANAGE_SAVED_KEY);
                    if (!raw) {
                        // 兼容早期 key，避免版本切换后用户误以为头像丢失
                        raw = localStorage.getItem(AVATAR_MANAGE_LEGACY_SAVED_KEY);
                    }
                    if (!raw) {
                        avatarSavedRoundList = [];
                        avatarSavedSquareList = [];
                        avatarSavedEnsureSeedDefaults();
                        return;
                    }
                    var obj = JSON.parse(raw);
                    var r = Array.isArray(obj && obj.round) ? obj.round.slice(0, 30) : [];
                    var q = Array.isArray(obj && obj.square) ? obj.square.slice(0, 30) : [];
                    avatarSavedRoundList = r.map(avatarSavedNormalizeEntry).filter(Boolean);
                    avatarSavedSquareList = q.map(avatarSavedNormalizeEntry).filter(Boolean);
                    if (
                        avatarSavedRoundList.length !== r.length ||
                        avatarSavedSquareList.length !== q.length
                    ) {
                        avatarSavedPersist();
                    }
                    avatarSavedEnsureSeedDefaults();
                } catch (e) {
                    avatarSavedRoundList = [];
                    avatarSavedSquareList = [];
                    avatarSavedEnsureSeedDefaults();
                }
            }
            window.avatarSavedLoad = avatarSavedLoad;

            function avatarSavedMergeFromRemoteList(rows) {
                var rr = [];
                var ss = [];
                for (var i = 0; i < rows.length; i++) {
                    var it = rows[i];
                    if (!it || !it.dataUrl) continue;
                    var shape = String(it.shape || '').toLowerCase();
                    var isBg;
                    if (it.is_bg === 0 || it.is_bg === false) {
                        isBg = 0;
                    } else if (it.is_bg === 1 || it.is_bg === true) {
                        isBg = 1;
                    } else {
                        var cat0 = String(it.category || '').toLowerCase();
                        isBg = cat0 === 'plain' ? 0 : 1;
                    }
                    var entry = avatarSavedNormalizeEntry({ dataUrl: it.dataUrl, is_bg: isBg });
                    if (!entry) continue;
                    if (shape === 'round') rr.push(entry);
                    else ss.push(entry);
                }
                if (rr.length) avatarSavedRoundList = rr.slice(0, 30);
                if (ss.length) avatarSavedSquareList = ss.slice(0, 30);
                avatarSavedEnsureSeedDefaults();
                avatarSavedPersist();
                avatarSavedRenderAll();
            }

            function avatarSavedLoadRemotePresets() {
                return fetch(avatarListApiUrl() + '?category=presets', {
                    method: 'GET',
                    cache: 'no-store'
                })
                    .then(function (r) {
                        return r.text().then(function (text) {
                            var j = null;
                            if (text) {
                                try {
                                    j = JSON.parse(text);
                                } catch (e) {}
                            }
                            return { ok: r.ok, j: j, status: r.status };
                        });
                    })
                    .then(function (x) {
                        if (!x.ok || !x.j || x.j.success !== true || !Array.isArray(x.j.avatars)) {
                            return false;
                        }
                        avatarSavedMergeFromRemoteList(x.j.avatars || []);
                        return true;
                    })
                    .catch(function (e) {
                        console.warn('avatar list remote load failed:', e);
                        return false;
                    });
            }
            window.avatarSavedLoadRemotePresets = avatarSavedLoadRemotePresets;

            /** 其它标签页或外部脚本改写了头像库 localStorage 时，与当前页内存对齐 */
            function avatarSavedOnStorageExternal(ev) {
                if (!ev || ev.key !== AVATAR_MANAGE_SAVED_KEY) return;
                avatarSavedLoad();
                var sel = window.avatarManageSelectedSaved;
                if (sel) {
                    var list = sel.shape === 'round' ? avatarSavedRoundList : avatarSavedSquareList;
                    var ok =
                        list &&
                        sel.index >= 0 &&
                        sel.index < list.length &&
                        avatarSavedNormalizeEntry(list[sel.index]);
                    if (!ok) {
                        window.avatarManageSelectedSaved = null;
                        if (!avatarManagePendingThumbDataUrl) {
                            if (avatarManagePreviewImg) {
                                avatarManagePreviewImg.removeAttribute('src');
                                avatarManagePreviewImg.style.display = 'none';
                                avatarManagePreviewImg.classList.remove('is-round', 'is-rect');
                            }
                            if (avatarManagePlaceholder) {
                                avatarManagePlaceholder.style.display = '';
                            }
                        }
                    }
                }
                avatarSavedRenderAll();
                avatarManageSyncButtons();
            }

            function avatarSavedRenderStrip(el, list, cls) {
                if (!el) return;
                el.innerHTML = '';
                if (!list || !list.length) {
                    var empty = document.createElement('span');
                    empty.className = 'avatar-saved-empty';
                    empty.textContent = '暂无';
                    el.appendChild(empty);
                    return;
                }
                for (var i = 0; i < list.length; i++) {
                    var item = avatarSavedNormalizeEntry(list[i]);
                    if (!item) continue;
                    var wrap = document.createElement('button');
                    wrap.type = 'button';
                    wrap.className = 'avatar-saved-thumb-wrap';
                    wrap.style.cssText = 'border:none;background:none;padding:0;cursor:pointer;';
                    var img = document.createElement('img');
                    var shapeKey = cls === 'is-round' ? 'round' : 'square';
                    var selected =
                        !!window.avatarManageSelectedSaved &&
                        window.avatarManageSelectedSaved.shape === shapeKey &&
                        window.avatarManageSelectedSaved.index === i;
                    img.className = 'avatar-saved-thumb ' + cls + (selected ? ' is-selected' : '');
                    img.src = item.dataUrl;
                    img.alt = cls === 'is-round' ? '圆形头像' : '方形头像';
                    wrap.appendChild(img);
                    var badge = document.createElement('span');
                    badge.className = 'avatar-saved-meta-badge';
                    badge.textContent = item.is_bg === 1 ? 'BG' : 'NO BG';
                    wrap.appendChild(badge);
                    (function (shape, idx) {
                        wrap.addEventListener('click', function () {
                            avatarSavedSetSelected(shape, idx);
                        });
                    })(shapeKey, i);
                    el.appendChild(wrap);
                }
            }

            function avatarSavedRenderAll() {
                avatarSavedRenderStrip(avatarSavedRoundStrip, avatarSavedRoundList, 'is-round');
                avatarSavedRenderStrip(avatarSavedSquareStrip, avatarSavedSquareList, 'is-square');
                window.syncHomeComposerAvatar();
            }

            function avatarSavedAppend(dataUrl, isRound, isBg) {
                if (!dataUrl) return;
                var target = isRound ? avatarSavedRoundList : avatarSavedSquareList;
                target.unshift({
                    dataUrl: dataUrl,
                    is_bg: isBg === 0 ? 0 : 1
                });
                if (target.length > 30) {
                    target.length = 30;
                }
                avatarSavedPersist();
                avatarSavedRenderAll();
            }

            function avatarSavedDeleteSelected() {
                if (!window.avatarManageSelectedSaved) return;
                var target = window.avatarManageSelectedSaved.shape === 'round'
                    ? avatarSavedRoundList
                    : avatarSavedSquareList;
                if (!target || window.avatarManageSelectedSaved.index < 0 || window.avatarManageSelectedSaved.index >= target.length) {
                    avatarSavedSetSelected(null, -1);
                    return;
                }
                target.splice(window.avatarManageSelectedSaved.index, 1);
                avatarSavedSetSelected(null, -1);
                avatarSavedPersist();
                avatarSavedRenderAll();
            }

            function avatarManageSavePending() {
                if (!avatarManagePendingThumbDataUrl) return;
                var isBg = avatarManageIsBgCheckbox && avatarManageIsBgCheckbox.checked ? 1 : 0;
                var ownerId = getCurrentAvatarOwnerId();
                if (avatarManageSaveBtn) avatarManageSaveBtn.disabled = true;
                fetch(avatarSaveApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uuid: ownerId || '',
                        preset: true,
                        dataUrl: avatarManagePendingThumbDataUrl,
                        isRound: !!avatarManagePendingIsRound,
                        isBg: isBg === 1
                    })
                })
                    .then(function (r) {
                        return r.text().then(function (text) {
                            var j = null;
                            if (text) {
                                try {
                                    j = JSON.parse(text);
                                } catch (e) {}
                            }
                            return { ok: r.ok, j: j, status: r.status };
                        });
                    })
                    .then(function (x) {
                        if (!x.ok || !x.j || x.j.success !== true) {
                            var msg =
                                (x.j && (x.j.error || x.j.msg)) ||
                                ('HTTP ' + (x.status != null ? x.status : '错误'));
                            console.warn('[avatar-save] failed', x.status, x.j || null);
                            alert('头像保存失败：' + msg);
                            return;
                        }
                        console.log('[avatar-save] ok', {
                            ownerId: ownerId,
                            r2_key: x.j && x.j.r2_key ? x.j.r2_key : '',
                            created_at: x.j && x.j.created_at ? x.j.created_at : 0
                        });
                        avatarSavedAppend(avatarManagePendingThumbDataUrl, avatarManagePendingIsRound, isBg);
                        avatarManageResetPreview();
                        avatarSavedLoadRemotePresets();
                    })
                    .catch(function (e) {
                        console.error(e);
                        alert('头像保存失败：网络异常');
                    })
                    .finally(function () {
                        avatarManageSyncButtons();
                    });
            }

            function avatarBuildThumbDataUrl(imgEl) {
                var c = document.createElement('canvas');
                c.width = 80;
                c.height = 80;
                var ctx = c.getContext('2d');
                if (!ctx) return '';
                var iw = imgEl.naturalWidth || 80;
                var ih = imgEl.naturalHeight || 80;
                var scale = Math.max(80 / iw, 80 / ih);
                var dw = iw * scale;
                var dh = ih * scale;
                var dx = (80 - dw) / 2;
                var dy = (80 - dh) / 2;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, 80, 80);
                ctx.drawImage(imgEl, dx, dy, dw, dh);
                return c.toDataURL('image/png');
            }

            function avatarDetectRoundShape(imgEl) {
                if (!imgEl) return false;
                var iw = imgEl.naturalWidth || 0;
                var ih = imgEl.naturalHeight || 0;
                if (!iw || !ih) return false;
                var c = document.createElement('canvas');
                c.width = 128;
                c.height = 128;
                var ctx = c.getContext('2d');
                if (!ctx) return false;
                ctx.clearRect(0, 0, 128, 128);
                var scale = Math.min(128 / iw, 128 / ih);
                var dw = iw * scale;
                var dh = ih * scale;
                var dx = (128 - dw) / 2;
                var dy = (128 - dh) / 2;
                ctx.drawImage(imgEl, dx, dy, dw, dh);

                var data = ctx.getImageData(0, 0, 128, 128).data;
                function alphaAt(x, y) {
                    var ix = ((y * 128 + x) * 4) + 3;
                    return data[ix] || 0;
                }
                function avgAlpha(x0, y0, w, h) {
                    var sum = 0;
                    var n = 0;
                    for (var y = y0; y < y0 + h; y++) {
                        for (var x = x0; x < x0 + w; x++) {
                            sum += alphaAt(x, y);
                            n++;
                        }
                    }
                    return n ? (sum / n) : 0;
                }

                var corner = (
                    avgAlpha(0, 0, 16, 16) +
                    avgAlpha(112, 0, 16, 16) +
                    avgAlpha(0, 112, 16, 16) +
                    avgAlpha(112, 112, 16, 16)
                ) / 4;
                var center = avgAlpha(48, 48, 32, 32);
                var edgeMid = (
                    avgAlpha(56, 0, 16, 10) +
                    avgAlpha(56, 118, 16, 10) +
                    avgAlpha(0, 56, 10, 16) +
                    avgAlpha(118, 56, 10, 16)
                ) / 4;
                var nearSquare = Math.abs(iw - ih) <= Math.max(iw, ih) * 0.08;

                // 圆形 PNG 常见特征：中心/边中明显不透明，四角明显透明
                if (nearSquare && center > 120 && edgeMid > 80 && corner < 35) {
                    return true;
                }
                return false;
            }

            function avatarManageApplyFile(file) {
                if (!file || !/^image\//i.test(String(file.type || ''))) {
                    alert('请拖入或粘贴图片文件。');
                    return;
                }
                var url = URL.createObjectURL(file);
                var img = new Image();
                img.onload = function () {
                    var isRound = avatarDetectRoundShape(img);
                    if (avatarManagePreviewImg) {
                        avatarManagePreviewImg.src = url;
                        avatarManagePreviewImg.style.display = 'block';
                        avatarManagePreviewImg.classList.remove('is-round', 'is-rect');
                        avatarManagePreviewImg.classList.add(isRound ? 'is-round' : 'is-rect');
                    }
                    if (avatarManagePlaceholder) {
                        avatarManagePlaceholder.style.display = 'none';
                    }
                    window.avatarManageSelectedSaved = null;
                    avatarManagePendingThumbDataUrl = avatarBuildThumbDataUrl(img);
                    avatarManagePendingIsRound = isRound;
                    avatarManageSyncButtons();
                    URL.revokeObjectURL(url);
                };
                img.onerror = function () {
                    URL.revokeObjectURL(url);
                    alert('图片读取失败，请换一张再试。');
                };
                img.src = url;
            }

            function avatarManageGetPastedImageFile(e) {
                if (!e || !e.clipboardData || !e.clipboardData.items) return null;
                var items = e.clipboardData.items;
                for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    if (it && it.kind === 'file' && /^image\//i.test(String(it.type || ''))) {
                        return it.getAsFile();
                    }
                }
                return null;
            }

            function closeAvatarManageModal() {
                if (!avatarManageModalOverlay) return;
                document.body.style.overflow = avatarManageModalBodyOverflowPrev;
                avatarManageModalOverlay.classList.remove('show');
                avatarManageModalOverlay.setAttribute('aria-hidden', 'true');
                if (avatarManageDropZone) {
                    avatarManageDropZone.classList.remove('is-dragover');
                }
                avatarManageResetPreview();
            }

            function openAvatarManageModal() {
                if (!avatarManageModalOverlay) return;
                avatarManageModalBodyOverflowPrev = document.body.style.overflow || '';
                document.body.style.overflow = 'hidden';
                avatarManageModalOverlay.classList.add('show');
                avatarManageModalOverlay.setAttribute('aria-hidden', 'false');
                avatarSavedLoad();
                avatarSavedLoadRemotePresets();
                avatarManageResetPreview();
                if (avatarManageDropZone) {
                    setTimeout(function () {
                        try { avatarManageDropZone.focus(); } catch (e) {}
                    }, 0);
                }
            }

            function clearUserListSelection() {
                if (!window.UserListGrid || typeof UserListGrid.getApi !== 'function') return;
                var api = UserListGrid.getApi();
                if (!api) return;
                if (typeof api.deselectAll === 'function') {
                    api.deselectAll();
                }
            }

            function locatePhoneInUserList(phoneRaw, options) {
                options = options || {};
                var silentNotFound = options.silentNotFound === true;
                var phone = String(phoneRaw || '').trim();
                if (!phone) {
                    clearUserListSelection();
                    return;
                }
                var targetKey = 'phone:' + phone;
                if (!window.UserListGrid || typeof UserListGrid.getApi !== 'function') {
                    if (!silentNotFound) alert('用户列表尚未加载完成。');
                    return;
                }
                var api = UserListGrid.getApi();
                if (!api) {
                    if (!silentNotFound) alert('用户列表尚未加载完成。');
                    return;
                }
                var hitNode = null;
                api.forEachNode(function (node) {
                    if (hitNode) return;
                    var d = node && node.data;
                    if (d && d.key === targetKey) {
                        hitNode = node;
                    }
                });
                if (!hitNode) {
                    if (!silentNotFound) alert('此手机不存在！');
                    return;
                }
                if (typeof api.deselectAll === 'function') {
                    api.deselectAll();
                }
                if (typeof hitNode.setSelected === 'function') {
                    hitNode.setSelected(true, true);
                }
                if (typeof api.ensureNodeVisible === 'function') {
                    api.ensureNodeVisible(hitNode, 'middle');
                }
                if (typeof api.setFocusedCell === 'function') {
                    api.setFocusedCell(hitNode.rowIndex, 'key');
                }
                if (typeof api.flashCells === 'function') {
                    api.flashCells({ rowNodes: [hitNode] });
                }
            }

            function requireTurnstileForUserList(onPass) {
                var cfg = window.APP_CONFIG && window.APP_CONFIG.TURNSTILE;
                if (!cfg || !cfg.enabled) {
                    onPass();
                    return;
                }
                if (!cfg.siteKey) {
                    showTurnstileDiagnosticDialog(
                        '未配置 Turnstile 站点密钥',
                        cfg,
                        '打开用户列表前未能获取 TURNSTILE.siteKey'
                    );
                    return;
                }
                openTurnstileOverlay(
                    cfg.siteKey,
                    cfg,
                    function () {
                        onPass();
                    }
                );
            }

            if (topNavUserList) {
                topNavUserList.addEventListener('click', function () {
                    requireTurnstileForUserList(openUserListModal);
                });
            }
            avatarSavedLoad();
            avatarSavedLoadRemotePresets();
            avatarSavedRenderAll();
            window.syncHomeComposerAvatar();
            window.addEventListener('storage', avatarSavedOnStorageExternal);
            window.addEventListener('storage', function (ev) {
                if (!ev || ev.key == null) return;
                if (String(ev.key).indexOf('L_ENG_profile_avatar_') !== 0) return;
                window.syncHomeComposerAvatar();
            });
            if (topNavAvatarManage) {
                topNavAvatarManage.addEventListener('click', function () {
                    openAvatarManageModal();
                });
            }
            if (avatarManageModalCloseBtn) {
                avatarManageModalCloseBtn.addEventListener('click', closeAvatarManageModal);
            }
            if (avatarManageModalOverlay) {
                avatarManageModalOverlay.addEventListener('click', function (e) {
                    if (e.target === avatarManageModalOverlay) {
                        closeAvatarManageModal();
                    }
                });
            }
            if (avatarManageSaveBtn) {
                avatarManageSaveBtn.addEventListener('click', function () {
                    avatarManageSavePending();
                });
            }
            if (avatarManageDeleteBtn) {
                avatarManageDeleteBtn.addEventListener('click', function () {
                    avatarSavedDeleteSelected();
                });
            }
            if (avatarManageResetBtn) {
                avatarManageResetBtn.addEventListener('click', function () {
                    avatarManageResetPreview();
                });
            }
            if (avatarManageDropZone) {
                avatarManageDropZone.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    avatarManageDropZone.classList.add('is-dragover');
                });
                avatarManageDropZone.addEventListener('dragleave', function (e) {
                    if (!avatarManageDropZone.contains(e.relatedTarget)) {
                        avatarManageDropZone.classList.remove('is-dragover');
                    }
                });
                avatarManageDropZone.addEventListener('drop', function (e) {
                    e.preventDefault();
                    avatarManageDropZone.classList.remove('is-dragover');
                    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                    if (file) {
                        avatarManageApplyFile(file);
                    }
                });
                avatarManageDropZone.addEventListener('paste', function (e) {
                    var f = avatarManageGetPastedImageFile(e);
                    if (!f) return;
                    e.preventDefault();
                    avatarManageApplyFile(f);
                });
            }
            document.addEventListener('paste', function (e) {
                if (!avatarManageModalOverlay || !avatarManageModalOverlay.classList.contains('show')) return;
                var f = avatarManageGetPastedImageFile(e);
                if (!f) return;
                e.preventDefault();
                avatarManageApplyFile(f);
            });
            if (userListModalCloseBtn) {
                userListModalCloseBtn.addEventListener('click', closeUserListModal);
            }
            if (userListModalOverlay) {
                userListModalOverlay.addEventListener('click', function (e) {
                    if (e.target === userListModalOverlay) closeUserListModal();
                });
            }
            if (userListSearchPhoneInput) {
                userListSearchPhoneInput.addEventListener('input', function () {
                    var d = this.value.replace(/\D/g, '');
                    if (this.value !== d) this.value = d;
                    if (userListSearchDebounceTimer) {
                        clearTimeout(userListSearchDebounceTimer);
                    }
                    var val = this.value;
                    userListSearchDebounceTimer = setTimeout(function () {
                        locatePhoneInUserList(val, { silentNotFound: true });
                    }, 120);
                });
                userListSearchPhoneInput.addEventListener('keydown', function (e) {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (userListSearchDebounceTimer) {
                        clearTimeout(userListSearchDebounceTimer);
                        userListSearchDebounceTimer = null;
                    }
                    locatePhoneInUserList(this.value, { silentNotFound: false });
                });
            }
            if (userListShowAllCheckbox) {
                userListShowAllCheckbox.addEventListener('change', function () {
                    userListSyncFilterCombosDisabled();
                    userListApplyTopFilters();
                });
            }
            if (userListTypeFilterSelect) {
                userListTypeFilterSelect.addEventListener('change', function () {
                    if (this.disabled) return;
                    userListApplyTopFilters();
                });
            }
            if (userListCTierFilterSelect) {
                userListCTierFilterSelect.addEventListener('change', function () {
                    if (this.disabled) return;
                    userListApplyTopFilters();
                });
            }
            userListSyncFilterCombosDisabled();
            if (userManageCollapseGroupsCheckbox) {
                userManageCollapseGroupsCheckbox.addEventListener('change', function () {
                    userManageExpandedGroups = {};
                    userListApplyTopFilters();
                });
            }
            if (userListRebuildGroupIndexBtn) {
                userListRebuildGroupIndexBtn.addEventListener('click', function () {
                    var isAll = userManageSelectedGroup === '' || userManageSelectedGroup == null;
                    var g = String(userManageSelectedGroup || '').trim();
                    var msg = isAll
                        ? '将按当前 KV 中全部用户重建所有组的组索引，是否继续？'
                        : '将仅重建「' + g + '」组的组索引（不影响其它组），是否继续？';
                    if (!confirm(msg)) return;
                    userListRebuildGroupIndexBtn.disabled = true;
                    var body = isAll ? {} : { group: g };
                    fetch(rebuildGroupIndexApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    })
                        .then(function (r) {
                            return r.text().then(function (t) {
                                var j = null;
                                if (t) {
                                    try { j = JSON.parse(t); } catch (e) {}
                                }
                                return { ok: r.ok, j: j, status: r.status };
                            });
                        })
                        .then(function (x) {
                            if (!x.ok || !x.j || x.j.success !== true) {
                                var errMsg =
                                    (x.j && (x.j.error || x.j.msg)) ||
                                    ('HTTP ' + (x.status != null ? x.status : '错误'));
                                alert('重建组索引失败：' + errMsg);
                                return;
                            }
                            if (x.j.scope === 'group' && x.j.group) {
                                alert(
                                    '组「' +
                                        x.j.group +
                                        '」重建完成：扫描 ' +
                                        (x.j.total_users || 0) +
                                        ' 条用户，写入索引 ' +
                                        (x.j.indexed || 0) +
                                        ' 条。'
                                );
                            } else {
                                alert(
                                    '全量重建完成：共处理 ' +
                                        (x.j.total_users || 0) +
                                        ' 个用户，写入索引 ' +
                                        (x.j.indexed || 0) +
                                        ' 条。'
                                );
                            }
                        })
                        .catch(function (e) {
                            alert('重建组索引失败：网络异常');
                            console.error(e);
                        })
                        .finally(function () {
                            userListRebuildGroupIndexBtn.disabled = false;
                        });
                });
            }
            if (userListRefreshGroupInviteCodesBtn) {
                userListRefreshGroupInviteCodesBtn.addEventListener('click', function () {
                    var isAll = userManageSelectedGroup === '' || userManageSelectedGroup == null;
                    var g = String(userManageSelectedGroup || '').trim();
                    var msg = isAll
                        ? '将重新生成「当前 KV 中出现的所有组」以及「全站默认组（若已设置）」的六位邀请码，旧码立即失效，是否继续？'
                        : '将重新生成「' +
                          g +
                          '」组的六位邀请码，旧码立即失效，是否继续？';
                    if (!confirm(msg)) return;
                    userListRefreshGroupInviteCodesBtn.disabled = true;
                    var body = isAll ? {} : { group: g };
                    fetch(refreshGroupInviteCodesApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    })
                        .then(function (r) {
                            return r.text().then(function (t) {
                                var j = null;
                                if (t) {
                                    try {
                                        j = JSON.parse(t);
                                    } catch (e) {}
                                }
                                return { ok: r.ok, j: j, status: r.status };
                            });
                        })
                        .then(function (x) {
                            if (!x.ok || !x.j || x.j.success !== true) {
                                var errMsg =
                                    (x.j && (x.j.error || x.j.msg)) ||
                                    ('HTTP ' + (x.status != null ? x.status : '错误'));
                                alert('刷新邀请码失败：' + errMsg);
                                return;
                            }
                            if (x.j.codes && x.j.codes.length) {
                                for (var cix = 0; cix < x.j.codes.length; cix++) {
                                    var rowc = x.j.codes[cix];
                                    var ggx = sanitizeRegisterGroupParam(String(rowc.group || ''));
                                    var ccx = normalizeInviteSixDigits(String(rowc.code || ''));
                                    if (ggx) {
                                        window.userManageGroupInviteCodeCache[ggx] = ccx || '';
                                    }
                                }
                                if (userManageGroupTree) {
                                    renderUserManageGroupTree(userListAllRowsCache);
                                }
                            }
                            return refreshHintDefaultGroupInviteCode().then(function () {
                                var n =
                                    x.j.refreshed != null
                                        ? x.j.refreshed
                                        : x.j.codes && x.j.codes.length
                                          ? x.j.codes.length
                                          : 0;
                                if (x.j.scope === 'group' && x.j.group) {
                                    alert('已刷新组「' + x.j.group + '」的邀请码。');
                                } else {
                                    alert('已批量刷新 ' + n + ' 个组的邀请码。');
                                }
                            });
                        })
                        .catch(function (e) {
                            alert('刷新邀请码失败：网络异常');
                            console.error(e);
                        })
                        .finally(function () {
                            userListRefreshGroupInviteCodesBtn.disabled = false;
                        });
                });
            }
            if (userListDefaultRegisterGroupSaveBtn) {
                userListDefaultRegisterGroupSaveBtn.addEventListener('click', function () {
                    var raw = userListDefaultRegisterGroupInput ? userListDefaultRegisterGroupInput.value : '';
                    var g = sanitizeRegisterGroupParam(raw);
                    if (!g) {
                        alert('组号无效：请输入 1～24 位，仅字母数字及 . _ -');
                        return;
                    }
                    userListDefaultRegisterGroupSaveBtn.disabled = true;
                    fetch(defaultRegisterGroupApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ group: g })
                    })
                        .then(function (r) {
                            return r.text().then(function (text) {
                                var j = null;
                                if (text) {
                                    try {
                                        j = JSON.parse(text);
                                    } catch (e) {}
                                }
                                return { ok: r.ok, j: j };
                            });
                        })
                        .then(function (x) {
                            if (!x.ok || !x.j || x.j.success !== true) {
                                var msg =
                                    (x.j && (x.j.error || x.j.msg)) ||
                                    ('HTTP ' + (x.status != null ? x.status : '错误'));
                                alert('保存失败：' + msg);
                                return;
                            }
                            defaultRegisterGroupServerCache.group = sanitizeRegisterGroupParam(
                                String(x.j.group || '')
                            );
                            defaultRegisterGroupServerCache.loaded = true;
                            refreshHintDefaultGroupInviteCode();
                            syncNewUserRegisterGroupLockUI();
                            alert('已写入服务器 KV。无邀请链接的新人注册将使用组「' + (x.j.group || g) + '」。');
                        })
                        .catch(function (e) {
                            console.error(e);
                            alert('保存失败：网络异常');
                        })
                        .finally(function () {
                            userListDefaultRegisterGroupSaveBtn.disabled = false;
                        });
                });
            }
            if (userListDefaultRegisterGroupClearBtn) {
                userListDefaultRegisterGroupClearBtn.addEventListener('click', function () {
                    if (!confirm('确定清空服务器上的全站默认组？')) return;
                    userListDefaultRegisterGroupClearBtn.disabled = true;
                    fetch(defaultRegisterGroupApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ group: '' })
                    })
                        .then(function (r) {
                            return r.text().then(function (text) {
                                var j = null;
                                if (text) {
                                    try {
                                        j = JSON.parse(text);
                                    } catch (e) {}
                                }
                                return { ok: r.ok, j: j };
                            });
                        })
                        .then(function (x) {
                            if (!x.ok || !x.j || x.j.success !== true) {
                                var msg =
                                    (x.j && (x.j.error || x.j.msg)) ||
                                    ('HTTP ' + (x.status != null ? x.status : '错误'));
                                alert('清空失败：' + msg);
                                return;
                            }
                            defaultRegisterGroupServerCache.group = '';
                            defaultRegisterGroupServerCache.loaded = true;
                            hintDefaultGroupInviteCode = '';
                            if (userListDefaultRegisterGroupInput) userListDefaultRegisterGroupInput.value = '';
                            updateUserListInviteLinkHint();
                            syncNewUserRegisterGroupLockUI();
                            window.userManageGroupInviteCodeCache = Object.create(null);
                            if (userManageGroupTree) {
                                renderUserManageGroupTree(userListAllRowsCache);
                            }
                        })
                        .catch(function (e) {
                            console.error(e);
                            alert('清空失败：网络异常');
                        })
                        .finally(function () {
                            userListDefaultRegisterGroupClearBtn.disabled = false;
                        });
                });
            }
            if (newUserRegInviteCodeInput) {
                newUserRegInviteCodeInput.addEventListener('input', function () {
                    var d = this.value.replace(/\D/g, '').slice(0, 6);
                    if (this.value !== d) this.value = d;
                });
            }
            if (newUserRegisterCloseBtn) {
                newUserRegisterCloseBtn.addEventListener('click', closeNewUserRegisterPanel);
            }
            if (newUserRegPhoneInput) {
                newUserRegPhoneInput.addEventListener('input', function () {
                    var d = this.value.replace(/\D/g, '');
                    if (this.value !== d) this.value = d;
                });
            }
            function newUserKvNeedsTurnstile() {
                if (
                    isAppDevDebugEnabled() &&
                    sessionStorage.getItem('L_ENG_debug_bypass_turnstile') === '1'
                ) {
                    return false;
                }
                var cfg = window.APP_CONFIG && window.APP_CONFIG.TURNSTILE;
                if (!cfg || cfg.requireForNewUserKv === false) return false;
                if (!cfg.enabled || !cfg.siteKey) return false;
                return true;
            }

            if (newUserRegPhoneNextBtn) {
                newUserRegPhoneNextBtn.addEventListener('click', function () {
                    var phone = newUserRegPhoneInput ? newUserRegPhoneInput.value.trim() : '';
                    if (!phone) return;
                    if (!/^\d+$/.test(phone)) {
                        alert('手机号错！');
                        return;
                    }
                    if (phone.length < 6) return;

                    function runNewUserRegisterSubmit() {
                    var nameRaw = newUserRegNameInput ? newUserRegNameInput.value.trim() : '';
                    var pwdRaw = newUserRegPwdInput ? newUserRegPwdInput.value.trim() : '';
                    var nameVal = nameRaw !== '' ? nameRaw : '二呆';
                    var pwdVal = pwdRaw !== '' ? pwdRaw : '123456';
                    var uuidVal =
                        typeof crypto !== 'undefined' && crypto.randomUUID
                            ? crypto.randomUUID()
                            : generateSessionId();
                    var keyStr = 'phone:' + phone;
                    var valueForPreview = {
                        uuid: uuidVal,
                        name: nameVal,
                        email: 'sdfxxx@163.com',
                        pwd: pwdVal
                    };
                    var effGrp = getEffectiveRegisterGroupForNewUser();
                    if (effGrp && effGrp.group) {
                        valueForPreview.group = String(effGrp.group);
                        valueForPreview.g_role = 0;
                    }
                    var metadataObj = getDefaultRegisterMetadata();
                    var apiBase =
                        window.APP_CONFIG && window.APP_CONFIG.API_CONFIG && window.APP_CONFIG.API_CONFIG.baseUrl
                            ? window.APP_CONFIG.API_CONFIG.baseUrl.replace(/\/$/, '')
                            : '';
                    var registerKvUrl =
                        window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                            ? '/api/register-kv'
                            : (apiBase || '') + '/api/register-kv';
                    var existsCheckUrl =
                        window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV
                            ? '/api/register-kv-key-exists?key=' + encodeURIComponent(keyStr)
                            : (apiBase || '') + '/api/register-kv-key-exists?key=' + encodeURIComponent(keyStr);

                    function registerKvJsonIsSuccess(x) {
                        if (!x || !x.ok || !x.j || typeof x.j !== 'object') return false;
                        var s = x.j.success;
                        if (s === true || s === 'true') return true;
                        if (x.j.key && x.j.success !== false && !x.j.error) return true;
                        return false;
                    }

                    function postRegisterKv(turnstileTokenOpt) {
                        var payload = {
                            key: keyStr,
                            value: valueForPreview,
                            metadata: metadataObj
                        };
                        var invPost = newUserRegInviteCodeInput
                            ? normalizeInviteSixDigits(newUserRegInviteCodeInput.value)
                            : '';
                        if (!invPost) {
                            var effInv = getEffectiveRegisterGroupForNewUser();
                            if (effInv && effInv.source === 'server_default') {
                                invPost = normalizeInviteSixDigits(hintDefaultGroupInviteCode || '');
                            }
                        }
                        if (invPost) {
                            payload.inviteCode = invPost;
                        }
                        if (turnstileTokenOpt) {
                            payload.turnstileToken = turnstileTokenOpt;
                        }
                        function buildRegisterKvFailureMsg(x) {
                            var base =
                                (x.j && (x.j.error || x.j.msg)) ||
                                ('HTTP ' + (x.status != null ? x.status : x.ok ? '200' : '错误'));
                            var extra = [];
                            if (x.j && x.j.detail) extra.push('detail=' + String(x.j.detail));
                            if (x.j && x.j['error-codes']) {
                                try {
                                    extra.push('error-codes=' + JSON.stringify(x.j['error-codes']));
                                } catch (e) {}
                            }
                            if ((x.status >= 500 || !x.j) && x.raw) {
                                var raw = String(x.raw).replace(/\s+/g, ' ').trim();
                                if (raw) extra.push('raw=' + raw.slice(0, 240));
                            }
                            return extra.length ? base + '\n' + extra.join('\n') : base;
                        }
                        fetch(registerKvUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        })
                            .then(function (r) {
                                return r.text().then(function (text) {
                                    var j = null;
                                    if (text) {
                                        try {
                                            j = JSON.parse(text);
                                        } catch (e) {
                                            console.error('[register-kv] 响应非 JSON', text.slice(0, 500));
                                        }
                                    }
                                    return { ok: r.ok, j: j, status: r.status, raw: text };
                                });
                            })
                            .then(function (x) {
                                if (registerKvJsonIsSuccess(x)) {
                                    window.persistRegistrationReceiptSuccess(keyStr, valueForPreview, metadataObj);
                                    window.unlockProfileNavPersist();
                                    hideNewUserKvPreview();
                                    closeNewUserRegisterPanel();
                                    alert('注册成功！请到个人资料处设置用户名、头像等！');
                                } else {
                                    if (x.status === 409 || (x.j && x.j.code === 'ALREADY_EXISTS')) {
                                        alert('该手机号已经注册！');
                                        window.persistRegistrationReceiptFailure('ALREADY_EXISTS');
                                        return;
                                    }
                                    if (x.status === 403 || (x.j && x.j.code === 'INVITE_MISMATCH')) {
                                        alert(
                                            '邀请码不正确。请填写组长提供的「组号(六位数字)」中的六位数字，或使用带 ?invite= 的完整邀请链接。'
                                        );
                                        window.persistRegistrationReceiptFailure('INVITE_MISMATCH');
                                        return;
                                    }
                                    var msg = buildRegisterKvFailureMsg(x);
                                    console.warn('[register-kv] 未成功', x.status, x.j || x.raw);
                                    window.persistRegistrationReceiptFailure(msg);
                                    alert(
                                        '保存失败：' +
                                            msg +
                                            '\n说明：个人资料与「用户列表」弹窗依赖 KV 保存成功。请完成人机验证，并检查 config.js 的 baseUrl、Turnstile siteKey 与线上 CORS。'
                                    );
                                }
                            })
                            .catch(function (err) {
                                console.error(err);
                                window.persistRegistrationReceiptFailure('网络异常');
                                alert('保存失败：网络异常');
                            });
                    }

                    fetch(existsCheckUrl, { method: 'GET', cache: 'no-store' })
                        .then(function (r) {
                            return r.text().then(function (text) {
                                var j = null;
                                if (text) {
                                    try {
                                        j = JSON.parse(text);
                                    } catch (e) {
                                        console.error('[register-kv-key-exists] 非 JSON', text.slice(0, 300));
                                    }
                                }
                                return { ok: r.ok, j: j, status: r.status };
                            });
                        })
                        .then(function (ex) {
                            if (!ex.ok || !ex.j || ex.j.success !== true) {
                                alert('无法校验手机号是否已注册，请稍后再试。');
                                return;
                            }
                            if (ex.j.exists === true) {
                                alert('该手机号已经注册！');
                                return;
                            }
                            var tcfg = window.APP_CONFIG && window.APP_CONFIG.TURNSTILE;
                            if (
                                tcfg &&
                                tcfg.enabled &&
                                tcfg.requireForNewUserKv !== false &&
                                !tcfg.siteKey
                            ) {
                                if (window.APP_CONFIG && window.APP_CONFIG.IS_LOCAL_DEV) {
                                    console.warn(
                                        '新人 KV：Turnstile 已启用但未配置 siteKey，将无 token 提交；服务端需 REGISTER_KV_SKIP_TURNSTILE 否则会失败'
                                    );
                                    postRegisterKv(null);
                                } else {
                                    alert(
                                        '未配置人机验证站点密钥：请在配置中填入 TURNSTILE.siteKey，并配置密钥 TURNSTILE_SECRET_KEY。'
                                    );
                                }
                                return;
                            }
                            if (newUserKvNeedsTurnstile()) {
                                openTurnstileOverlay(
                                    tcfg.siteKey,
                                    tcfg,
                                    function (token) {
                                        postRegisterKv(token);
                                    },
                                    true
                                );
                            } else {
                                postRegisterKv(null);
                            }
                        })
                        .catch(function (err) {
                            console.error(err);
                            alert('无法校验手机号是否已注册，请检查网络。');
                        });
                    }

                    refreshDefaultRegisterGroupFromServer()
                        .then(function () {
                            return refreshHintDefaultGroupInviteCode();
                        })
                        .then(function () {
                            applyNewUserInvitePrefillFromServerDefault();
                            runNewUserRegisterSubmit();
                        })
                        .catch(function (err) {
                            console.warn(err);
                            applyNewUserInvitePrefillFromServerDefault();
                            runNewUserRegisterSubmit();
                        });
                });
            }
            var registerDebugBypassTurnstile = document.getElementById('registerDebugBypassTurnstile');
            if (registerDebugBypassTurnstile) {
                registerDebugBypassTurnstile.addEventListener('change', function () {
                    sessionStorage.setItem('L_ENG_debug_bypass_turnstile', this.checked ? '1' : '0');
                });
            }
            if (turnstileCancelBtn && turnstileOverlay) {
                turnstileCancelBtn.addEventListener('click', closeTurnstileOverlay);
                turnstileOverlay.addEventListener('click', function (e) {
                    if (e.target === turnstileOverlay) closeTurnstileOverlay();
                });
            }
            var registerPwdSubmitting = false;
            if (registerSubmitBtn) {
                registerSubmitBtn.addEventListener('click', async function () {
                    if (registerPwdSubmitting) return;
                    var phone = registerPhoneInput ? registerPhoneInput.value.trim() : '';
                    var password = String((registerPwdInput && registerPwdInput.value) || '')
                        .replace(/[\u200B-\u200D\uFEFF]/g, '')
                        .trim();
                    if (!phone) {
                        alert('请输入手机号。');
                        return;
                    }
                    if (!password) {
                        alert('请输入密码。');
                        return;
                    }
                    hideNewUserKvPreview();
                    registerPwdSubmitting = true;
                    var oldPwdBtnText = registerSubmitBtn.textContent;
                    registerSubmitBtn.disabled = true;
                    registerSubmitBtn.textContent = '登录中...';
                    setRegisterLoginStatus('pwd', '正在请求 /api/check-user …', 'pending');
                    try {
                        var req = await requestCheckUserWithDiagnostics({ phone: phone, password: password });
                        var x = { j: req.data || {} };
                        if (!x.j || x.j.success !== true) {
                            var msg = (x.j && (x.j.error || x.j.msg)) || '未知错误';
                            setRegisterLoginStatus('pwd', '登录失败：' + msg, 'error');
                            alert('登录失败：' + msg);
                            return;
                        }
                        if (!x.j.phone_exists) {
                            registerPwdNotFoundCount++;
                            setRegisterLoginStatus('pwd', '该号码不存在！', 'error');
                            alert('该号码不存在！');
                            if (registerPwdNotFoundCount >= 3) {
                                alert('手机号连续三次不存在，已关闭登录窗口。');
                                registerPwdNotFoundCount = 0;
                                registerPwdWrongCount = 0;
                                closeRegister();
                            }
                            return;
                        }
                        registerPwdNotFoundCount = 0;
                        if (x.j.password_matches === true) {
                            registerPwdWrongCount = 0;
                        } else if (x.j.password_matches === false) {
                            var pvFalse = x.j.password_verifiable;
                            // 只有“明确可校验且不匹配”才算真正密码错误；否则按链路/状态异常处理，避免误报“密码错”
                            if (pvFalse === true) {
                                registerPwdWrongCount++;
                                var phf = String((x.j && x.j.password_hash_format) || '');
                                var wrongMsg =
                                    phf === 'argon2id_unsupported'
                                        ? '密码错！当前账号密码哈希为旧版 Argon2id，边缘无法校验。请改用扫码登录后重设密码。'
                                        : '密码错！';
                                setRegisterLoginStatus('pwd', wrongMsg, 'error');
                                alert(
                                    phf === 'argon2id_unsupported'
                                        ? '密码错！\n说明：当前账号的密码哈希为旧版 Argon2id，边缘环境无法校验。请改用「验证码登录」，登录后在个人资料中重设密码以迁移为新格式。'
                                        : '密码错！'
                                );
                                if (registerPwdWrongCount >= 3) {
                                    alert('密码连续三次错误，已关闭登录窗口。');
                                    registerPwdNotFoundCount = 0;
                                    registerPwdWrongCount = 0;
                                    closeRegister();
                                }
                                return;
                            }
                            var hintFalse =
                                pvFalse === false
                                    ? '\n\n该账号可能没有设置登录密码，请改用「验证码登录」。'
                                    : '\n\n本次校验链路不稳定（如人机验证耗时过长/边缘抖动），请稍后重试，或改用「验证码登录」。';
                            setRegisterLoginStatus('pwd', '暂时无法校验密码。' + hintFalse.replace(/\n+/g, ' '), 'error');
                            alert('暂时无法校验密码。' + hintFalse);
                            return;
                        } else {
                            var pv = x.j.password_verifiable;
                            var hint =
                                pv === false
                                    ? '\n\n该账号可能没有设置登录密码，请改用「验证码登录」。'
                                    : '\n\n服务器未返回明确校验结果（常见于网络或边缘短暂异常），请稍后重试，或改用「验证码登录」。';
                            setRegisterLoginStatus('pwd', '暂时无法校验密码。' + hint.replace(/\n+/g, ' '), 'error');
                            alert('暂时无法校验密码。' + hint);
                            return;
                        }
                        if (x.j.is_superuser === true) {
                            setRegisterSuperAuthMode(phone, true);
                            markRegisterSuperAuthPart(phone, 'pwd');
                            registerSuperAuthState.lastVerifiedPassword = password;
                            if (registerSuperAuthState.codeVerified === true) {
                                setAdminMenusVisible(true);
                                window.markProfileNavUnlockedByLogin(
                                    phone,
                                    (x.j && x.j.stored_username) || '',
                                    (x.j && x.j.stored_email) || '',
                                    password,
                                    (x.j && x.j.user_data && x.j.user_data.other_data) || '',
                                    (x.j && x.j.user_data) || {}
                                );
                                setRegisterLoginStatus('pwd', '登录成功', 'ok');
                                closeRegister();
                                return;
                            }
                            setRegisterLoginStatus('pwd', '密码已通过，还需要邮箱验证码验证', 'pending');
                            alert('你还需要邮箱验证码验证！');
                            switchRegisterTab('code');
                            var cphEl = document.getElementById('registerCodePhoneInput');
                            var cemEl = document.getElementById('registerCodeEmailInput');
                            var cnameEl = document.getElementById('registerCodeUsernameInput');
                            if (cphEl) cphEl.value = phone;
                            if (cemEl && x.j.stored_email) cemEl.value = String(x.j.stored_email);
                            if (cnameEl && x.j.stored_username) cnameEl.value = String(x.j.stored_username);
                            return;
                        }
                        setRegisterSuperAuthMode(phone, false);
                        setAdminMenusVisible(false);
                        window.markProfileNavUnlockedByLogin(
                            phone,
                            (x.j && x.j.stored_username) || '',
                            (x.j && x.j.stored_email) || '',
                            password,
                            (x.j && x.j.user_data && x.j.user_data.other_data) || '',
                            (x.j && x.j.user_data) || {}
                        );
                        setRegisterLoginStatus('pwd', '登录成功', 'ok');
                        closeRegister();
                    } catch (err) {
                        console.error(err);
                        var failMsg = String((err && err.message) || err || '网络异常');
                        setRegisterLoginStatus('pwd', '登录失败：' + failMsg, 'error');
                        alert('登录失败：' + failMsg);
                    } finally {
                        registerPwdSubmitting = false;
                        registerSubmitBtn.disabled = false;
                        registerSubmitBtn.textContent = oldPwdBtnText || '登录';
                    }
                });
            }
            if (registerCloseBtn) {
                registerCloseBtn.addEventListener('click', closeRegister);
            }
            registerTabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    var name = this.getAttribute('data-rtab');
                    if (name) switchRegisterTab(name);
                });
            });
            function clearRegisterSendCodeCooldown() {
                if (registerSendCodeCooldownInterval) {
                    clearInterval(registerSendCodeCooldownInterval);
                    registerSendCodeCooldownInterval = null;
                }
                if (registerSendCodeCooldownLabel) {
                    registerSendCodeCooldownLabel.textContent = '';
                    registerSendCodeCooldownLabel.classList.remove('visible');
                }
            }

            function fmtRegisterSendCooldown(sec) {
                var m = Math.floor(sec / 60);
                var s = sec % 60;
                return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
            }

            function startRegisterSendCodeCooldown() {
                clearRegisterSendCodeCooldown();
                var endTime = Date.now() + 4 * 60 * 1000;
                function tick() {
                    var left = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
                    if (registerSendCodeCooldownLabel) {
                        registerSendCodeCooldownLabel.textContent = fmtRegisterSendCooldown(left);
                        registerSendCodeCooldownLabel.classList.add('visible');
                    }
                    if (left <= 0) {
                        clearRegisterSendCodeCooldown();
                        if (registerPanel && registerPanel.classList.contains('show')) {
                            refreshCameraQr();
                        }
                    }
                }
                tick();
                registerSendCodeCooldownInterval = setInterval(tick, 1000);
            }

            function resetRegisterSuperAuthState() {
                registerSuperAuthState.phone = '';
                registerSuperAuthState.codeVerified = false;
                registerSuperAuthState.pwdVerified = false;
                registerSuperAuthState.isSuperuser = false;
                registerSuperAuthState.lastVerifiedPassword = '';
                refreshRegisterSuperAuthHint();
            }

            function refreshRegisterSuperAuthHint() {
                if (!registerSuperAuthHint) return;
                if (!registerSuperAuthState.isSuperuser || !registerSuperAuthState.phone) {
                    registerSuperAuthHint.setAttribute('hidden', '');
                    registerSuperAuthHint.textContent = '';
                    return;
                }
                var c = registerSuperAuthState.codeVerified ? '验证码√' : '验证码×';
                var p = registerSuperAuthState.pwdVerified ? '密码√' : '密码×';
                registerSuperAuthHint.textContent =
                    '超级用户二次认证进度：' + c + '，' + p + '（手机号：' + registerSuperAuthState.phone + '）';
                registerSuperAuthHint.removeAttribute('hidden');
            }

            function setRegisterSuperAuthMode(phone, isSuperuser) {
                var p = String(phone || '').trim();
                if (!isSuperuser || !p) {
                    resetRegisterSuperAuthState();
                    return;
                }
                if (registerSuperAuthState.phone !== p) {
                    registerSuperAuthState.phone = p;
                    registerSuperAuthState.codeVerified = false;
                    registerSuperAuthState.pwdVerified = false;
                    registerSuperAuthState.lastVerifiedPassword = '';
                }
                registerSuperAuthState.isSuperuser = true;
                refreshRegisterSuperAuthHint();
            }

            function markRegisterSuperAuthPart(phone, part) {
                var p = String(phone || '').trim();
                if (!p) return;
                if (registerSuperAuthState.phone !== p) {
                    registerSuperAuthState.phone = p;
                    registerSuperAuthState.codeVerified = false;
                    registerSuperAuthState.pwdVerified = false;
                    registerSuperAuthState.lastVerifiedPassword = '';
                }
                registerSuperAuthState.isSuperuser = true;
                if (part === 'code') registerSuperAuthState.codeVerified = true;
                if (part === 'pwd') registerSuperAuthState.pwdVerified = true;
                refreshRegisterSuperAuthHint();
            }

            function shouldLogVerificationCodeToConsole() {
                var cfg = window.APP_CONFIG && window.APP_CONFIG.DEV_CONFIG;
                return !cfg || cfg.logVerificationCodeToConsole !== false;
            }

            function logRegisterVerificationCodeToConsole(code, email, note) {
                if (!shouldLogVerificationCodeToConsole()) return;
                var c = String(code || '').trim();
                if (!c) return;
                var mail = String(email || '').trim();
                var suffix = note ? ' · ' + note : '';
                console.log(
                    '%c【登录验证码】%c ' +
                        c +
                        ' %c→ ' +
                        (mail || '(未填邮箱)') +
                        suffix +
                        ' %c（F12 → Console）',
                    'background:#161823;color:#fff;font-size:13px;padding:4px 8px;border-radius:4px;',
                    'background:#0b7285;color:#fff;font-size:24px;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:0.12em;',
                    'color:#666;font-size:12px;',
                    'color:#999;font-size:11px;'
                );
                console.info('[登录验证码] 6位码:', c, '邮箱:', mail || '(未填)', note || '');
            }

            async function registerSendEmailCodeHandler() {
                var usernameEl = document.getElementById('registerCodeUsernameInput');
                var phoneEl = document.getElementById('registerCodePhoneInput');
                var emailEl = document.getElementById('registerCodeEmailInput');
                var username = usernameEl ? usernameEl.value.trim() : '';
                var phone = phoneEl ? phoneEl.value.trim() : '';
                var email = emailEl ? emailEl.value.trim() : '';
                if (!username) {
                    alert('用户名不能为空！');
                    return false;
                }
                if (!phone) {
                    alert('手机号不能为空！');
                    return false;
                }
                if (!email) {
                    alert('邮箱不能为空！');
                    return false;
                }
                var newCode = Math.floor(100000 + Math.random() * 900000).toString();
                console.log('[验证码登录] 将调用 /api/send-email-code 发往邮箱:', email);
                try {
                    var response = await fetch(sendEmailCodeApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: email, code: newCode })
                    });
                    if (!response.ok) {
                        var errorText = await response.text();
                        console.error('[验证码登录] 发送失败（验证码未写入会话，请重试）:', errorText);
                        console.log('[验证码登录] 本次生成的验证码仍为（调试用）:', newCode);
                        var failDetail = '';
                        try {
                            var ej = JSON.parse(errorText);
                            failDetail = (ej && (ej.error || ej.msg)) || '';
                        } catch (eParse) {}
                        var failMsg = failDetail
                            ? '发送验证码失败：' + failDetail
                            : '发送验证码失败，请稍后重试（HTTP ' + response.status + '）';
                        setRegisterLoginStatus('code', failMsg, 'error');
                        alert(failMsg);
                        return false;
                    }
                    registerEmailVerificationCode = newCode;
                    registerEmailVerificationBind = {
                        phone: phone,
                        email: email
                    };
                    logRegisterVerificationCodeToConsole(newCode, email, '与邮件正文一致');
                    setRegisterLoginStatus(
                        'code',
                        '验证码已发送；未收到邮件请按 F12 在 Console 查看',
                        'ok'
                    );
                    alert(
                        '验证码已发送。\n若邮箱未收到，请按 F12 打开 Console，搜索「登录验证码」。'
                    );
                    startRegisterSendCodeCooldown();
                    return true;
                } catch (err) {
                    console.error('发送验证码异常:', err);
                    setRegisterLoginStatus(
                        'code',
                        '发送验证码网络异常：' + String((err && err.message) || err || ''),
                        'error'
                    );
                    alert('网络异常，请稍后重试');
                    return false;
                }
            }

            var registerCodeSubmitting = false;
            async function registerCodeLoginSubmit() {
                if (registerCodeSubmitting) return;
                var usernameEl = document.getElementById('registerCodeUsernameInput');
                var phoneEl = document.getElementById('registerCodePhoneInput');
                var emailEl = document.getElementById('registerCodeEmailInput');
                var codeEl = document.getElementById('registerSmsCodeInput');
                var username = usernameEl ? usernameEl.value.trim() : '';
                var phone = phoneEl ? phoneEl.value.trim() : '';
                var email = emailEl ? emailEl.value.trim() : '';
                var code = codeEl ? codeEl.value.trim() : '';

                if (!username) {
                    alert('用户名不能为空！');
                    return;
                }
                if (!phone) {
                    alert('手机号不能为空！');
                    return;
                }
                if (!email) {
                    alert('邮箱不能为空！');
                    return;
                }
                if (registerEmailVerificationCode == null) {
                    alert('请先使用手机相机扫描二维码获取验证码！');
                    return;
                }
                if (!code) {
                    alert('请输入验证码！');
                    return;
                }
                if (code !== registerEmailVerificationCode) {
                    alert('验证码错！');
                    return;
                }
                if (
                    !registerEmailVerificationBind ||
                    registerEmailVerificationBind.phone !== phone ||
                    registerEmailVerificationBind.email !== email
                ) {
                    alert('手机号/邮箱与验证码申请时不一致，请重新获取验证码。');
                    return;
                }

                registerCodeSubmitting = true;
                var oldCodeBtnText = registerLoginCodeBtn ? registerLoginCodeBtn.textContent : '';
                if (registerLoginCodeBtn) {
                    registerLoginCodeBtn.disabled = true;
                    registerLoginCodeBtn.textContent = '登录中...';
                }
                setRegisterLoginStatus('code', '正在校验用户信息 …', 'pending');
                try {
                    var req = await requestCheckUserWithDiagnostics({
                        phone: phone,
                        email: email,
                        username: username
                    });
                    var result = req.data || {};
                    if (!result.success) {
                        setRegisterLoginStatus('code', '查询用户信息失败: ' + (result.error || '未知错误'), 'error');
                        alert('查询用户信息失败: ' + (result.error || '未知错误'));
                        return;
                    }
                    if (!result.phone_exists) {
                        setRegisterLoginStatus('code', '查无此手机号，无法登录。', 'error');
                        alert('查无此手机号，无法登录。');
                        return;
                    }
                    if (result.user_status === 3) {
                        setRegisterLoginStatus('code', '你已被注销，请联系系统管理员！', 'error');
                        alert('你已被注销，请联系系统管理员！');
                        return;
                    }
                    if (!result.email_matches) {
                        setRegisterLoginStatus('code', '邮箱与登记信息不一致，无法登录。', 'error');
                        alert('邮箱与登记信息不一致，无法登录。');
                        return;
                    }
                    if (!result.username_matches) {
                        setRegisterLoginStatus('code', '用户名与登记信息不一致，无法登录。', 'error');
                        alert('用户名与登记信息不一致，无法登录。');
                        return;
                    }

                    if (result.is_superuser === true) {
                        setRegisterSuperAuthMode(phone, true);
                        markRegisterSuperAuthPart(phone, 'code');
                        if (registerSuperAuthState.pwdVerified === true) {
                            setAdminMenusVisible(true);
                            window.markProfileNavUnlockedByLogin(
                                phone,
                                username,
                                email,
                                registerSuperAuthState.lastVerifiedPassword || '',
                                (result && result.user_data && result.user_data.other_data) || '',
                                (result && result.user_data) || {}
                            );
                            setRegisterLoginStatus('code', '登录成功', 'ok');
                            closeRegister();
                            return;
                        }
                        setRegisterLoginStatus('code', '验证码已通过，还需要密码验证', 'pending');
                        alert('你还需要密码验证！');
                        switchRegisterTab('pwd');
                        if (registerPhoneInput) registerPhoneInput.value = phone;
                        return;
                    }
                    setRegisterSuperAuthMode(phone, false);
                    setAdminMenusVisible(false);
                    window.markProfileNavUnlockedByLogin(
                        phone,
                        username,
                        email,
                        '',
                        (result && result.user_data && result.user_data.other_data) || '',
                        (result && result.user_data) || {}
                    );
                    setRegisterLoginStatus('code', '登录成功', 'ok');
                    closeRegister();
                } catch (err) {
                    console.error('验证码登录校验异常:', err);
                    var codeFail = String((err && err.message) || err || '网络异常');
                    setRegisterLoginStatus('code', '登录失败：' + codeFail, 'error');
                    alert('登录失败：' + codeFail);
                } finally {
                    registerCodeSubmitting = false;
                    if (registerLoginCodeBtn) {
                        registerLoginCodeBtn.disabled = false;
                        registerLoginCodeBtn.textContent = oldCodeBtnText || '登录';
                    }
                }
            }

            if (registerLoginCodeBtn) {
                registerLoginCodeBtn.addEventListener('click', registerCodeLoginSubmit);
            }
            function resetEmbeddedScanLoginState() {
                var actionWrap = document.getElementById('actionWrap');
                if (actionWrap) {
                    actionWrap.style.display = 'none';
                    actionWrap.style.minHeight = '';
                    actionWrap.style.height = '';
                }
                if (registerScanCol) {
                    registerScanCol.style.minHeight = '';
                    registerScanCol.style.paddingBottom = '';
                    registerScanCol.style.transition = '';
                }
                var regDlg = document.querySelector('.register-dialog');
                if (regDlg) {
                    regDlg.style.maxHeight = '';
                    regDlg.style.overflowY = '';
                }
                isFirstSubmit = true;
                verificationCode = null;
                isAuthFlowActive = false;
                var codeRow = document.querySelector('#registerScanCol .input-row.user-info-row:nth-child(4)');
                if (codeRow) codeRow.style.display = 'flex';
                var authRows = document.querySelectorAll('#registerScanCol .auth-row');
                authRows.forEach(function (row) {
                    row.style.display = 'none';
                });
                var ui = document.getElementById('usernameInput');
                var ei = document.getElementById('emailInput');
                var pi = document.getElementById('phoneInput');
                var ci = document.getElementById('codeInput');
                var aci = document.getElementById('authCodeInput');
                if (ui) ui.value = '';
                if (ei) ei.value = '';
                if (pi) pi.value = '';
                if (ci) ci.value = '';
                if (aci) aci.value = '';
                var codeTimer = document.getElementById('codeTimer');
                if (codeTimer) {
                    codeTimer.style.display = 'none';
                    codeTimer.textContent = '';
                    codeTimer.style.color = '#333';
                }
                if (window.codeCountdownTimer) {
                    clearInterval(window.codeCountdownTimer);
                    window.codeCountdownTimer = null;
                }
                var st = document.getElementById('submitBtn');
                if (st) st.textContent = '提交';
                if (cameraQrImg) cameraQrImg.style.display = 'block';
            }

            function suppressSafariLoginAutofillOnce() {
                var nodes = [registerPhoneInput, registerPwdInput];
                for (var i = 0; i < nodes.length; i++) {
                    var el = nodes[i];
                    if (!el) continue;
                    el.setAttribute('readonly', 'readonly');
                    el.value = '';
                }
                setTimeout(function () {
                    for (var j = 0; j < nodes.length; j++) {
                        var x = nodes[j];
                        if (!x) continue;
                        x.removeAttribute('readonly');
                    }
                }, 80);
            }

            function openRegister() {
                if (!registerPanel) return;
                resetEmbeddedScanLoginState();
                registerPanel.classList.add('show');
                registerPanel.setAttribute('aria-hidden', 'false');
                switchRegisterTab('code');
                if (registerPhoneInput) registerPhoneInput.value = '';
                if (registerPwdInput) registerPwdInput.value = '';
                var cname = document.getElementById('registerCodeUsernameInput');
                var cph = document.getElementById('registerCodePhoneInput');
                var cem = document.getElementById('registerCodeEmailInput');
                var csm = document.getElementById('registerSmsCodeInput');
                if (cname) cname.value = '';
                if (cph) cph.value = '';
                if (cem) cem.value = '';
                if (csm) csm.value = '';
                registerEmailVerificationCode = null;
                registerEmailVerificationBind = null;
                resetRegisterSuperAuthState();
                clearRegisterSendCodeCooldown();
                suppressSafariLoginAutofillOnce();
                refreshCameraQr();
                syncRegisterDevToolbar();
            }

            function openNewUserRegisterPanel() {
                if (!newUserRegisterPanel) return;
                hideNewUserKvPreview();
                newUserRegisterPanel.classList.add('show');
                newUserRegisterPanel.setAttribute('aria-hidden', 'false');
                if (newUserRegNameInput) newUserRegNameInput.value = '';
                if (newUserRegPhoneInput) newUserRegPhoneInput.value = '';
                if (newUserRegPwdInput) newUserRegPwdInput.value = '';
                refreshDefaultRegisterGroupFromServer()
                    .then(function () {
                        return refreshHintDefaultGroupInviteCode();
                    })
                    .then(function () {
                        syncNewUserRegisterGroupLockUI();
                        applyNewUserInvitePrefillFromServerDefault();
                        syncNewUserRegInviteRow();
                    })
                    .catch(function () {
                        syncNewUserRegisterGroupLockUI();
                        applyNewUserInvitePrefillFromServerDefault();
                        syncNewUserRegInviteRow();
                    });
                if (newUserRegNameInput) newUserRegNameInput.focus();
            }

            function closeNewUserRegisterPanel() {
                if (!newUserRegisterPanel) return;
                hideNewUserKvPreview();
                newUserRegisterPanel.classList.remove('show');
                newUserRegisterPanel.setAttribute('aria-hidden', 'true');
            }

            function closeRegister() {
                if (!registerPanel) return;
                window.stopPolling();
                registerPanel.classList.remove('show');
                registerPanel.setAttribute('aria-hidden', 'true');
                clearRegisterQrCountdownUI();
                clearRegisterSendCodeCooldown();
                registerEmailVerificationCode = null;
                registerEmailVerificationBind = null;
                resetRegisterSuperAuthState();
                resetEmbeddedScanLoginState();
            }


    window.L_ENG_Register = {
        open: openRegister,
        openLoginFlow: beginRegisterFlow,
        openNew: openNewUserRegisterPanel,
        close: closeRegister,
        closeNew: closeNewUserRegisterPanel
    };

})();
