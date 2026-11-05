/**
 * Passkey 前端 T6：登录/注册/凭据管理入口接线。
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

  function showFailure(button, action) {
    var status = getStatus(button, action);
    if (status) {
      status.textContent = vagueMessage();
      status.hidden = false;
    }
    openAuthMenu();
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
      .catch(function () {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        showFailure(button, action);
      });
  }

  function closePanelOnOutsideClick(target) {
    var panel = getCredentialsPanel();
    if (!panel || !isPanelOpen()) return;
    if (target && typeof panel.contains === "function" && panel.contains(target)) return;
    hideCredentialsPanel();
  }

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
  });
})(typeof window !== "undefined" ? window : globalThis);
