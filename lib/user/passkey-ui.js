/**
 * Passkey 前端：登录/注册/凭据管理入口接线 + 注册前 reauth 兜底。
 * 依赖 window.HZDVPasskeyLogin / window.HZDVPasskeyRegister / window.HZDVPasskeyAuth。
 * 失败只显示模糊提示，不自动降级。
 */
(function (global) {
  "use strict";

  var LOGIN_SELECTOR = '[data-auth="passkey-login"]';
  var REGISTER_SELECTOR = '[data-auth="passkey-register"]';
  var CREDENTIALS_SELECTOR = '[data-auth="passkey-credentials"]';
  var REVOKE_SELECTOR = "[data-passkey-revoke]";
  var ENTRY_SELECTOR = LOGIN_SELECTOR + ", " + REGISTER_SELECTOR;
  var DEFAULT_VAGUE_FAIL = "Passkey operation could not be completed";
  var login = global.HZDVPasskeyLogin;
  var register = global.HZDVPasskeyRegister;
  var authApi = global.HZDVPasskeyAuth;

  function vagueMessage() {
    var auth = global.HZDVPasskeyAuth;
    return (auth && auth.VAGUE_FAIL) || DEFAULT_VAGUE_FAIL;
  }

  function getAuthMenu() {
    return document.getElementById("auth-menu");
  }

  function getAuthToggle() {
    return document.getElementById("topNavUserLogin");
  }

  function closeAuthMenu() {
    var menu = getAuthMenu();
    var toggle = getAuthToggle();
    if (menu) menu.classList.remove("open");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function openAuthMenu() {
    var menu = getAuthMenu();
    var toggle = getAuthToggle();
    if (menu) menu.classList.add("open");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }

  function getStatus(button, action) {
    var parent = button.parentElement;
    if (!parent) return null;
    var statusAttr = "data-passkey-" + action + "-status";
    var status = parent.querySelector("[" + statusAttr + "]");
    if (!status) {
      status = document.createElement("span");
      status.setAttribute(statusAttr, "");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.style.marginLeft = "8px";
      status.hidden = true;
      if (typeof button.insertAdjacentElement === "function") {
        button.insertAdjacentElement("afterend", status);
      } else {
        parent.appendChild(status);
      }
    }
    return status;
  }

  function clearFailure(button, action) {
    var status = getStatus(button, action);
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
  }

  function showFailure(button, action, message) {
    var status = getStatus(button, action);
    if (status) {
      status.textContent = message || vagueMessage();
      status.hidden = false;
    }
    openAuthMenu();
  }

  // ── 文案分流：只按 NotAllowedError / needReauth / 404-429-5xx 三类 ──
  // 严禁按 err.status 判断「账号是否存在 / 是否已有通行密钥」。
  function needsReauth(err) {
    if (!err) return false;
    if (err.needReauth === true) return true;
    // 兼容后端尚未下发 needReauth 布尔时的 401：仅用于触发「重新验证身份」，
    // 不用于任何账号存在性判断，也不产生账号相关文案。
    return err.status === 401;
  }

  function globalStateMessage(err) {
    var status = err && err.status;
    if (status === 404) return "该功能暂不可用。";
    if (status === 429) return "尝试过于频繁，请稍后再试。";
    if (typeof status === "number" && status >= 500) return "服务暂不可用，请稍后再试。";
    return "";
  }

  function messageForError(err, action) {
    if (err && err.kind === "notallowed") {
      // 浏览器原生 NotAllowedError：设备上没有可用通行密钥，或用户取消了选择
      return "此设备上没有可用的通行密钥，或你取消了选择。请改用密码 / 邮箱登录。";
    }
    var globalMsg = globalStateMessage(err);
    if (globalMsg) return globalMsg;
    if (action === "login" && err && err.needReauth === true) {
      return "需要重新验证后再试。";
    }
    return vagueMessage();
  }

  // ── 注册前 reauth 兜底（手机号 + 密码 → /api/passkey/reauth）──
  // 票据只保存在内存；手机号/密码不写入 localStorage，也不作为身份。
  var reauthPanel = null;
  var reauthToken = "";

  function closeReauthPanel() {
    if (reauthPanel && reauthPanel.parentNode) {
      reauthPanel.parentNode.removeChild(reauthPanel);
    }
    reauthPanel = null;
    reauthToken = "";
  }

  function setReauthStatus(message) {
    if (!reauthPanel) return;
    var status = reauthPanel.querySelector("[data-passkey-reauth-status]");
    if (!status) return;
    status.textContent = message || "";
    status.hidden = !message;
  }

  function retryRegisterWithToken(button, token) {
    if (!registerReady || !token || !button) {
      if (button) showFailure(button, "register", vagueMessage());
      reauthToken = "";
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    Promise.resolve()
      .then(function () {
        return register.registerPasskey({ reauthToken: token });
      })
      .then(function () {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        reauthToken = "";
        handleSuccess(button, "register");
      })
      .catch(function (err) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        reauthToken = "";
        if (needsReauth(err)) {
          // 已重新验证仍被拒：不再自动循环，提示用户手动重试
          showFailure(button, "register", "身份验证未通过，请重试。");
          return;
        }
        showFailure(button, "register", messageForError(err, "register"));
      });
  }

  function openReauthPanel(triggerButton) {
    if (reauthPanel) {
      var existingPhone = reauthPanel.querySelector("[data-passkey-reauth-phone]");
      if (existingPhone && typeof existingPhone.focus === "function") existingPhone.focus();
      return;
    }
    if (!authApi || typeof authApi.fetchJSON !== "function" || !document.body) {
      if (triggerButton) showFailure(triggerButton, "register", vagueMessage());
      return;
    }

    var panel = document.createElement("div");
    panel.setAttribute("id", "passkeyReauthPanel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "重新验证身份");
    panel.style.position = "fixed";
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.transform = "translate(-50%, -50%)";
    panel.style.zIndex = "10050";
    panel.style.minWidth = "260px";
    panel.style.maxWidth = "90vw";
    panel.style.padding = "16px";
    panel.style.borderRadius = "8px";
    panel.style.background = "var(--dropdown-bg, #ffffff)";
    panel.style.color = "var(--dropdown-text, #111111)";
    panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.18)";

    var title = document.createElement("div");
    title.textContent = "为绑定通行密钥，请先验证身份";
    panel.appendChild(title);

    var phoneInput = document.createElement("input");
    phoneInput.setAttribute("type", "tel");
    phoneInput.setAttribute("data-passkey-reauth-phone", "");
    phoneInput.setAttribute("placeholder", "手机号");
    phoneInput.setAttribute("autocomplete", "username");
    phoneInput.style.display = "block";
    phoneInput.style.width = "100%";
    phoneInput.style.margin = "8px 0";
    panel.appendChild(phoneInput);

    var passwordInput = document.createElement("input");
    passwordInput.setAttribute("type", "password");
    passwordInput.setAttribute("data-passkey-reauth-password", "");
    passwordInput.setAttribute("placeholder", "密码");
    passwordInput.setAttribute("autocomplete", "current-password");
    passwordInput.style.display = "block";
    passwordInput.style.width = "100%";
    passwordInput.style.margin = "8px 0";
    panel.appendChild(passwordInput);

    var status = document.createElement("div");
    status.setAttribute("data-passkey-reauth-status", "");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.style.marginTop = "8px";
    status.hidden = true;
    panel.appendChild(status);

    var actions = document.createElement("div");
    actions.style.marginTop = "12px";
    actions.style.display = "flex";
    actions.style.gap = "8px";
    var submitButton = document.createElement("button");
    submitButton.setAttribute("type", "button");
    submitButton.textContent = "验证并继续";
    var cancelButton = document.createElement("button");
    cancelButton.setAttribute("type", "button");
    cancelButton.textContent = "取消";
    actions.appendChild(submitButton);
    actions.appendChild(cancelButton);
    panel.appendChild(actions);

    function submitReauth() {
      var phoneValue = String(phoneInput.value || "").trim();
      var passwordValue = String(passwordInput.value || "");
      if (!phoneValue || !passwordValue) {
        setReauthStatus("请输入手机号和密码。");
        return;
      }
      submitButton.disabled = true;
      setReauthStatus("验证中…");
      Promise.resolve()
        .then(function () {
          return authApi.fetchJSON("/api/passkey/reauth", {
            method: "POST",
            body: { method: "password", phone: phoneValue, password: passwordValue },
          });
        })
        .then(function (data) {
          var token = data && data.reauthToken ? String(data.reauthToken) : "";
          passwordInput.value = "";
          submitButton.disabled = false;
          if (!token) {
            setReauthStatus(vagueMessage());
            return;
          }
          var retryButton = triggerButton;
          closeReauthPanel();
          reauthToken = token;
          retryRegisterWithToken(retryButton, token);
        })
        .catch(function (err) {
          submitButton.disabled = false;
          passwordInput.value = "";
          var msg = globalStateMessage(err);
          // 手机号不存在与密码错误使用同一文案，不泄露账号存在性
          if (err && err.status === 401) msg = "验证未通过，请重试。";
          setReauthStatus(msg || vagueMessage());
        });
    }

    submitButton.addEventListener("click", submitReauth);
    cancelButton.addEventListener("click", function () {
      closeReauthPanel();
    });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submitReauth();
      } else if (e.key === "Escape") {
        closeReauthPanel();
      }
    });

    document.body.appendChild(panel);
    reauthPanel = panel;
    if (typeof phoneInput.focus === "function") phoneInput.focus();
  }

  function getCredentialsPanel() {
    return document.getElementById("passkeyCredentialsPanel");
  }

  function translate(key, zhText, enText) {
    var lang = global.currentLang === "en" ? "en" : "zh";
    try {
      if (typeof translations !== "undefined" && translations && translations[lang] && translations[lang][key]) {
        return translations[lang][key];
      }
    } catch (err) {}
    return lang === "en" ? enText : zhText;
  }

  function isPanelOpen() {
    var panel = getCredentialsPanel();
    return !!(panel && panel.classList.contains("open"));
  }

  function hideCredentialsPanel() {
    var panel = getCredentialsPanel();
    if (!panel) return;
    panel.classList.remove("open");
    panel.hidden = true;
    panel.textContent = "";
  }

  function openCredentialsPanel() {
    var panel = getCredentialsPanel();
    if (!panel) return;
    panel.hidden = false;
    panel.classList.add("open");
  }

  function renderPanelMessage(message) {
    var panel = getCredentialsPanel();
    if (!panel) return;
    panel.textContent = "";
    var line = document.createElement("div");
    line.style.padding = "10px 16px";
    line.textContent = message;
    panel.appendChild(line);
  }

  function formatCreatedAt(value) {
    var ms = Number(value);
    if (!ms || !isFinite(ms)) return "";
    try {
      return new Date(ms).toISOString().slice(0, 10);
    } catch (err) {
      return "";
    }
  }

  function credentialLabel(credential) {
    var name = credential && credential.name ? String(credential.name) : "";
    if (!name) {
      var rawId = credential && credential.id ? String(credential.id) : "";
      name = rawId ? rawId.slice(0, 12) + "…" : "";
    }
    var created = formatCreatedAt(credential && credential.createdAt);
    return name + (created ? " · " + created : "");
  }

  function renderCredentials(credentials) {
    var panel = getCredentialsPanel();
    if (!panel) return;
    panel.textContent = "";
    if (!credentials || !credentials.length) {
      renderPanelMessage(translate("auth_passkey_empty", "暂无 Passkey", "No passkeys yet"));
      return;
    }
    credentials.forEach(function (credential) {
      var credentialId = credential && credential.id ? String(credential.id) : "";
      var row = document.createElement("div");
      row.style.padding = "8px 16px";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "8px";
      var label = document.createElement("span");
      label.textContent = credentialLabel(credential);
      var revoke = document.createElement("button");
      revoke.setAttribute("type", "button");
      revoke.setAttribute("data-passkey-revoke", credentialId);
      revoke.textContent = translate("auth_passkey_revoke", "撤销", "Revoke");
      revoke.style.width = "auto";
      revoke.style.padding = "4px 10px";
      revoke.style.flexShrink = "0";
      row.appendChild(label);
      row.appendChild(revoke);
      panel.appendChild(row);
    });
  }

  function loadCredentials() {
    if (!credentialsReady) {
      renderPanelMessage(vagueMessage());
      return;
    }
    renderPanelMessage(translate("auth_passkey_loading", "加载中…", "Loading…"));
    Promise.resolve()
      .then(function () {
        return authApi.listPasskeys();
      })
      .then(function (data) {
        var list = data && Array.isArray(data.credentials) ? data.credentials : [];
        renderCredentials(list);
      })
      .catch(function () {
        renderPanelMessage(vagueMessage());
      });
  }

  function toggleCredentialsPanel() {
    if (isPanelOpen()) {
      hideCredentialsPanel();
      return;
    }
    openCredentialsPanel();
    loadCredentials();
  }

  function handleRevoke(revokeButton) {
    var credentialId = revokeButton.getAttribute("data-passkey-revoke") || "";
    if (!credentialId || !credentialsReady) return;
    var question = translate("auth_passkey_revoke_confirm", "确认撤销这把 Passkey？", "Revoke this passkey?");
    if (typeof global.confirm === "function" && !global.confirm(question)) return;
    Promise.resolve()
      .then(function () {
        return authApi.revokePasskey(credentialId);
      })
      .then(function () {
        loadCredentials();
      })
      .catch(function () {
        renderPanelMessage(vagueMessage());
      });
  }

  function hideUnsupportedEntry() {
    document.querySelectorAll(ENTRY_SELECTOR).forEach(function (button) {
      button.hidden = true;
      var item = button.closest("li");
      if (item) {
        item.hidden = true;
        item.style.display = "none";
      }
    });
  }

  var loginReady = login && typeof login.loginWithPasskey === "function";
  var registerReady = register && typeof register.registerPasskey === "function";
  var credentialsReady = !!(authApi && typeof authApi.listPasskeys === "function" && typeof authApi.revokePasskey === "function");
  if (!loginReady && !registerReady && !credentialsReady) return;

  if (!global.PublicKeyCredential) {
    hideUnsupportedEntry();
  }

  function reloadPage() {
    if (global.location && typeof global.location.reload === "function") {
      global.location.reload();
    }
  }

  function syncLoggedInState() {
    try {
      global.localStorage.setItem("leng_logged_in", "1");
    } catch (err) {}
  }

  function handleSuccess(button, action) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (action === "login") syncLoggedInState();
    try {
      if (typeof global.syncAuthMenuMode === "function") {
        global.syncAuthMenuMode();
      }
    } catch (err) {}
    reloadPage();
  }

  function runCeremony(button, action, invoke) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    clearFailure(button, action);
    closeAuthMenu();

    Promise.resolve()
      .then(invoke)
      .then(function () {
        handleSuccess(button, action);
      })
      .catch(function (err) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (action === "register" && needsReauth(err)) {
          // 注册需要一次身份验证 → 弹最小 reauth 表单，成功后自动重试一次
          openReauthPanel(button);
          return;
        }
        showFailure(button, action, messageForError(err, action));
      });
  }

  function closePanelOnOutsideClick(target) {
    var panel = getCredentialsPanel();
    if (!panel || !isPanelOpen()) return;
    if (target && typeof panel.contains === "function" && panel.contains(target)) return;
    hideCredentialsPanel();
  }

  // 捕获阶段监听（capture=true）：#auth-menu 的 click 处理器在 index.html 里调用了
  // e.stopPropagation()，冒泡阶段收不到菜单内点击，故必须在捕获阶段接管三个 passkey 入口。
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;

    var revokeButton = target.closest(REVOKE_SELECTOR);
    if (revokeButton) {
      event.preventDefault();
      handleRevoke(revokeButton);
      return;
    }

    var action = "login";
    var button = target.closest(LOGIN_SELECTOR);
    if (!button) {
      action = "register";
      button = target.closest(REGISTER_SELECTOR);
    }
    if (!button) {
      action = "credentials";
      button = target.closest(CREDENTIALS_SELECTOR);
    }
    if (!button) {
      closePanelOnOutsideClick(target);
      return;
    }
    if (button.disabled) return;

    event.preventDefault();
    if (action === "login" && loginReady) {
      runCeremony(button, action, function () {
        return login.loginWithPasskey();
      });
      return;
    }
    if (action === "register" && registerReady) {
      runCeremony(button, action, function () {
        return register.registerPasskey();
      });
      return;
    }
    if (action === "credentials") {
      toggleCredentialsPanel();
      return;
    }

    showFailure(button, action);
  }, true);
})(typeof window !== "undefined" ? window : globalThis);
