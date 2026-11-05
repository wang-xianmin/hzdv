/**
 * Passkey 前端 T5：登录/注册入口接线。
 * 依赖 window.HZDVPasskeyLogin 与 window.HZDVPasskeyRegister；失败只显示模糊提示，不自动降级。
 */
(function (global) {
  "use strict";

  var LOGIN_SELECTOR = '[data-auth="passkey-login"]';
  var REGISTER_SELECTOR = '[data-auth="passkey-register"]';
  var ENTRY_SELECTOR = LOGIN_SELECTOR + ", " + REGISTER_SELECTOR;
  var DEFAULT_VAGUE_FAIL = "Passkey operation could not be completed";
  var login = global.HZDVPasskeyLogin;
  var register = global.HZDVPasskeyRegister;

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
  if (!loginReady && !registerReady) return;

  if (!global.PublicKeyCredential) {
    hideUnsupportedEntry();
    return;
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

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;

    var action = "login";
    var button = target.closest(LOGIN_SELECTOR);
    if (!button) {
      action = "register";
      button = target.closest(REGISTER_SELECTOR);
    }
    if (!button || button.disabled) return;

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

    showFailure(button, action);
  });
})(typeof window !== "undefined" ? window : globalThis);
