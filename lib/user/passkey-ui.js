/**
 * Passkey 前端 T4：最小登录入口接线（依赖 window.HZDVPasskeyLogin）。
 * 仅处理 data-auth="passkey-login"；失败只显示模糊提示，不自动降级。
 */
(function (global) {
  "use strict";

  var SELECTOR = '[data-auth="passkey-login"]';
  var DEFAULT_VAGUE_FAIL = "Passkey operation could not be completed";
  var login = global.HZDVPasskeyLogin;

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

  function getStatus(button) {
    var parent = button.parentElement;
    if (!parent) return null;
    var status = parent.querySelector("[data-passkey-login-status]");
    if (!status) {
      status = document.createElement("span");
      status.setAttribute("data-passkey-login-status", "");
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

  function clearFailure(button) {
    var status = getStatus(button);
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
  }

  function showFailure(button) {
    var status = getStatus(button);
    if (status) {
      status.textContent = vagueMessage();
      status.hidden = false;
    }
    openAuthMenu();
  }

  function hideUnsupportedEntry() {
    document.querySelectorAll(SELECTOR).forEach(function (button) {
      button.hidden = true;
      var item = button.closest("li");
      if (item) {
        item.hidden = true;
        item.style.display = "none";
      }
    });
  }

  if (!login || typeof login.loginWithPasskey !== "function") return;

  if (!global.PublicKeyCredential) {
    hideUnsupportedEntry();
    return;
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var button = target.closest(SELECTOR);
    if (!button || button.disabled) return;

    event.preventDefault();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    clearFailure(button);
    closeAuthMenu();

    Promise.resolve()
      .then(function () {
        return login.loginWithPasskey();
      })
      .then(function () {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (typeof global.syncAuthMenuMode === "function") {
          global.syncAuthMenuMode();
        }
        if (global.location && typeof global.location.reload === "function") {
          global.location.reload();
        }
      })
      .catch(function () {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        showFailure(button);
      });
  });
})(typeof window !== "undefined" ? window : globalThis);
