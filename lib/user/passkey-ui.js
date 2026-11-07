/**
 * Passkey 前端：可复用的通行密钥管理接口（注册/列表/撤销）。
 * 依赖 window.HZDVPasskeyRegister / window.HZDVPasskeyAuth。
 * 失败只显示模糊提示，不自动降级。
 *
 * 顶栏「Passkey 登录」菜单项已下线（登录入口并入登录弹窗的通行密钥 Tab），
 * 本文件不再接线登录入口。
 *
 * 对外暴露 window.HZDVPasskeyManager：
 *   list()                 -> Promise<credentials[]>            拉取凭据列表
 *   format(credential)     -> string                            凭据展示文案
 *   renderSummary(el, list, opts) -> void                       在指定容器渲染摘要行
 *   register(opts)         -> void                              注册（含 reauth 兜底）
 *   revoke(id, opts)       -> void                              撤销（已登录免 reauth，401 时才回退）
 */
(function (global) {
  "use strict";

  var REVOKE_SELECTOR = "[data-passkey-revoke]";
  var DEFAULT_VAGUE_FAIL = "Passkey operation could not be completed";
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

  function openAuthMenu() {
    var menu = getAuthMenu();
    var toggle = getAuthToggle();
    if (menu) menu.classList.add("open");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }

  function inAuthMenu(node) {
    var menu = getAuthMenu();
    return !!(menu && node && typeof menu.contains === "function" && menu.contains(node));
  }

  function getStatus(button, action) {
    var parent = button && button.parentElement;
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
    // 只有顶栏入口才需要把下拉菜单重新打开；资料面板内的按钮不碰顶栏。
    if (inAuthMenu(button)) openAuthMenu();
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
    return vagueMessage();
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

  // ── reauth（手机号 + 密码 → /api/passkey/reauth）──
  // 票据只保存在内存；手机号/密码不写入 localStorage，也不作为身份。
  // 浮层始终是 body 级 position:fixed + z-index 3000（高于资料模态框），
  // 避免嵌进资料面板后被 overflow 裁剪；anchor 仅用于滚动定位与聚焦。
  var reauthPanel = null;
  var reauthToken = "";
  var reauthPending = null;

  function clearReauthToken() {
    reauthToken = "";
  }

  function closeReauthPanel() {
    if (reauthPanel && reauthPanel.parentNode) {
      reauthPanel.parentNode.removeChild(reauthPanel);
    }
    reauthPanel = null;
    reauthPending = null;
  }

  function setReauthStatus(message) {
    if (!reauthPanel) return;
    var status = reauthPanel.querySelector("[data-passkey-reauth-status]");
    if (!status) return;
    status.textContent = message || "";
    status.hidden = !message;
  }

  function scrollAnchorIntoView(anchor) {
    if (!anchor) return;
    try {
      if (typeof anchor.scrollIntoView === "function") {
        anchor.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch (err) {
      try { anchor.scrollIntoView(); } catch (err2) {}
    }
  }

  /**
   * 打开 reauth 浮层。
   * @param {HTMLElement=} triggerButton 触发按钮（用于焦点回退与状态提示）
   * @param {Object=} opts {action:'register'|'revoke', credentialId, anchor, onSuccess, onError}
   */
  function openReauthPanel(triggerButton, opts) {
    var options = opts || {};
    reauthPending = {
      action: options.action === "revoke" ? "revoke" : "register",
      credentialId: String(options.credentialId || ""),
      triggerButton: triggerButton || null,
      anchor: options.anchor || null,
      onSuccess: typeof options.onSuccess === "function" ? options.onSuccess : null,
      onError: typeof options.onError === "function" ? options.onError : null,
    };
    if (reauthPanel) {
      var existingPhone = reauthPanel.querySelector("[data-passkey-reauth-phone]");
      if (existingPhone && typeof existingPhone.focus === "function") existingPhone.focus();
      return;
    }
    if (!authApi || typeof authApi.fetchJSON !== "function" || !document.body) {
      if (triggerButton) showFailure(triggerButton, "register", vagueMessage());
      if (reauthPending.onError) reauthPending.onError(null, vagueMessage());
      return;
    }

    var panel = document.createElement("div");
    panel.setAttribute("id", "passkeyReauthPanel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "重新验证身份");
    panel.className = "passkey-reauth-panel";
    panel.style.position = "fixed";
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.transform = "translate(-50%, -50%)";
    panel.style.zIndex = "3000";
    panel.style.minWidth = "260px";
    panel.style.maxWidth = "90vw";
    panel.style.maxHeight = "80vh";
    panel.style.overflow = "auto";
    panel.style.padding = "16px";
    panel.style.borderRadius = "8px";
    panel.style.background = "var(--dropdown-bg, #ffffff)";
    panel.style.color = "var(--dropdown-text, #111111)";
    panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.18)";

    var title = document.createElement("div");
    title.textContent = reauthPending.action === "revoke"
      ? "为撤销通行密钥，请先验证身份"
      : "为绑定通行密钥，请先验证身份";
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
          var pending = reauthPending;
          closeReauthPanel();
          reauthToken = token;
          if (pending.action === "revoke") {
            retryRevokeWithToken(
              pending.triggerButton,
              token,
              pending.credentialId,
              pending.onSuccess,
              pending.onError
            );
          } else {
            retryRegisterWithToken(
              pending.triggerButton,
              token,
              pending.onSuccess,
              pending.onError
            );
          }
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
      var pending = reauthPending;
      closeReauthPanel();
      clearReauthToken();
      if (pending && pending.onError) pending.onError(null, "已取消");
    });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submitReauth();
      } else if (e.key === "Escape") {
        var pendingEsc = reauthPending;
        closeReauthPanel();
        clearReauthToken();
        if (pendingEsc && pendingEsc.onError) pendingEsc.onError(null, "已取消");
      }
    });

    document.body.appendChild(panel);
    reauthPanel = panel;
    scrollAnchorIntoView(reauthPending.anchor);
    if (typeof phoneInput.focus === "function") phoneInput.focus();
  }

  function resetButton(button) {
    if (!button) return;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }

  function reportFailure(button, action, err, opts) {
    var msg = messageForError(err, action);
    var options = opts || {};
    if (typeof options.onError === "function") {
      options.onError(err, msg);
      return;
    }
    showFailure(button, action, msg);
  }

  /** reauth 通过后的注册重试 */
  function retryRegisterWithToken(button, token, onSuccess, onError) {
    if (!registerReady || !token || !button) {
      if (button) showFailure(button, "register", vagueMessage());
      clearReauthToken();
      if (typeof onError === "function") onError(null, vagueMessage());
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    Promise.resolve()
      .then(function () {
        return register.registerPasskey({ reauthToken: token });
      })
      .then(function () {
        resetButton(button);
        clearReauthToken();
        if (typeof onSuccess === "function") onSuccess();
        else handleSuccess(button);
      })
      .catch(function (err) {
        resetButton(button);
        clearReauthToken();
        if (needsReauth(err)) {
          // 已重新验证仍被拒：不再自动循环，提示用户手动重试
          if (typeof onError === "function") onError(err, "身份验证未通过，请重试。");
          else showFailure(button, "register", "身份验证未通过，请重试。");
          return;
        }
        if (typeof onError === "function") onError(err, messageForError(err, "register"));
        else showFailure(button, "register", messageForError(err, "register"));
      });
  }

  /** reauth 通过后的撤销重试：票据走 X-Reauth-Token 请求头，不用 DELETE body */
  function retryRevokeWithToken(button, token, credentialId, onSuccess, onError) {
    if (!credentialsReady || !token || !credentialId || !button) {
      if (button) showFailure(button, "revoke", vagueMessage());
      clearReauthToken();
      if (typeof onError === "function") onError(null, vagueMessage());
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    Promise.resolve()
      .then(function () {
        return authApi.revokePasskey(credentialId, token);
      })
      .then(function () {
        resetButton(button);
        clearReauthToken();
        if (typeof onSuccess === "function") onSuccess();
      })
      .catch(function (err) {
        resetButton(button);
        clearReauthToken();
        if (typeof onError === "function") onError(err, messageForError(err, "revoke"));
        else showFailure(button, "revoke", messageForError(err, "revoke"));
      });
  }

  // ── 列表 / 摘要渲染（容器可指定，供个人资料面板复用）──
  function fetchCredentials() {
    if (!credentialsReady) {
      return Promise.reject(new Error(vagueMessage()));
    }
    return Promise.resolve()
      .then(function () {
        return authApi.listPasskeys();
      })
      .then(function (data) {
        return data && Array.isArray(data.credentials) ? data.credentials : [];
      });
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

  function renderSummaryMessage(container, message) {
    if (!container) return;
    var line = document.createElement("div");
    line.style.padding = "4px 0";
    line.style.fontSize = "13px";
    line.style.color = "#555";
    line.textContent = message;
    container.appendChild(line);
  }

  /**
   * 在指定容器渲染凭据摘要行（主面板不堆完整列表）。
   * @param {HTMLElement} container
   * @param {Array} credentials
   * @param {Object=} opts {onRevoke:function(credentialId, button)}
   */
  function renderCredentialSummary(container, credentials, opts) {
    if (!container) return;
    var options = opts || {};
    container.textContent = "";
    var list = credentials && credentials.length ? credentials : [];
    if (!list.length) {
      // 空态不显示任何消息
      return;
    }
    list.forEach(function (credential) {
      var credentialId = credential && credential.id ? String(credential.id) : "";
      var row = document.createElement("div");
      row.className = "profile-passkey-row";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "flex-start";
      row.style.gap = "8px";
      var label = document.createElement("span");
      label.className = "profile-passkey-label";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.style.whiteSpace = "nowrap";
      // 允许收缩：否则长凭据名会把「撤销」挤出面板（flex 项默认 min-width:auto 不缩）
      label.style.minWidth = "0";
      label.textContent = credentialLabel(credential);
      var revoke = document.createElement("button");
      revoke.setAttribute("type", "button");
      revoke.setAttribute("data-passkey-revoke", credentialId);
      revoke.textContent = translate("auth_passkey_revoke", "撤销", "Revoke");
      revoke.style.width = "auto";
      revoke.style.padding = "4px 10px";
      revoke.style.flexShrink = "0";
      if (typeof options.onRevoke === "function") {
        // 由调用方自己处理时，标记为已托管，避免文档级捕获处理器重复触发撤销。
        revoke.setAttribute("data-passkey-revoke-managed", "");
        revoke.addEventListener("click", function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.stopPropagation) e.stopPropagation();
          options.onRevoke(credentialId, revoke);
        });
      }
      row.appendChild(label);
      row.appendChild(revoke);
      container.appendChild(row);
    });
  }

  // ── 对外管理接口 ──
  /**
   * 注册通行密钥。
   *
   * 顺序契约（个人资料「已登录免再输手机号/密码」）：
   *   1) 先直接 registerPasskey()（fetch credentials:'include'，站点 Cookie 随请求带上）；
   *      服务端 resolveIdentity 已桥接站点 auth-token，因此有登录态时零弹窗直达系统 WebAuthn。
   *   2) 仅当服务端返回 401 / needReauth（确实没有可验证身份）时，才弹 reauth 浮层，
   *      验证通过后带票据重试一次；不自动循环。
   *
   * @param {Object=} opts {triggerButton, anchor, onSuccess, onError}
   */
  function registerWithReauth(opts) {
    var options = opts || {};
    var button = options.triggerButton || null;
    if (!registerReady || !button) {
      if (button) showFailure(button, "register", vagueMessage());
      if (typeof options.onError === "function") options.onError(null, vagueMessage());
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    clearFailure(button, "register");
    Promise.resolve()
      .then(function () {
        return register.registerPasskey();
      })
      .then(function () {
        resetButton(button);
        if (typeof options.onSuccess === "function") options.onSuccess();
        else handleSuccess(button);
      })
      .catch(function (err) {
        resetButton(button);
        if (needsReauth(err)) {
          // 需要一次身份验证 → 弹最小 reauth 表单，成功后自动重试一次
          openReauthPanel(button, {
            action: "register",
            anchor: options.anchor,
            onSuccess: options.onSuccess,
            onError: options.onError,
          });
          return;
        }
        reportFailure(button, "register", err, options);
      });
  }

  /**
   * 撤销通行密钥。
   *
   * 顺序契约（个人资料「已登录免再输手机号/密码」）：
   *   1) 先 confirm 确认文案；用户取消 → 中止，不发任何请求；
   *   2) 再直接 revokePasskey(id)（不带 X-Reauth-Token，fetch credentials:'include'
   *      会带上站点登录 Cookie），服务端据此确认身份；
   *   3) 仅当服务端返回 401 / needReauth（确实没有可验证身份）时，才弹 reauth 浮层，
   *      验证通过后带票据重试一次；不自动循环。
   *
   * 撤销只清理服务端凭据，当前浏览器已建立的登录 session 保持有效；
   * 手机上的私钥需用户自行删除（confirm 文案已提示同步删除）。
   */
  function revokeWithReauth(credentialId, opts) {
    var options = opts || {};
    var button = options.triggerButton || null;
    if (!credentialsReady || !credentialId) {
      if (button) showFailure(button, "revoke", vagueMessage());
      if (typeof options.onError === "function") options.onError(null, vagueMessage());
      return;
    }
    var question = translate(
      "auth_passkey_revoke_confirm",
      "撤销通行密钥，需要同步删除手机上的hzdv.net私钥",
      "Revoke this passkey?"
    );
    if (typeof global.confirm === "function" && !global.confirm(question)) return;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      clearFailure(button, "revoke");
    }
    Promise.resolve()
      .then(function () {
        // 不带票据：服务端可用站点登录态（hz_auth Cookie）确认身份
        return authApi.revokePasskey(credentialId);
      })
      .then(function () {
        resetButton(button);
        if (typeof options.onSuccess === "function") options.onSuccess();
      })
      .catch(function (err) {
        resetButton(button);
        if (needsReauth(err)) {
          // 服务端认为没有可验证身份 → 弹最小 reauth 表单，通过后带票据重试一次
          openReauthPanel(button, {
            action: "revoke",
            credentialId: credentialId,
            anchor: options.anchor,
            onSuccess: options.onSuccess,
            onError: options.onError,
          });
          return;
        }
        reportFailure(button, "revoke", err, options);
      });
  }

  var registerReady = register && typeof register.registerPasskey === "function";
  var credentialsReady = !!(authApi && typeof authApi.listPasskeys === "function" && typeof authApi.revokePasskey === "function");

  // 稳定的全局管理接口：个人资料面板等外部调用方只依赖这一层。
  // 即使某个底层模块缺失也要导出，调用方据此拿到不可用状态而不是 undefined。
  global.HZDVPasskeyManager = {
    isSupported: !!global.PublicKeyCredential,
    list: fetchCredentials,
    format: credentialLabel,
    renderSummary: renderCredentialSummary,
    register: registerWithReauth,
    revoke: revokeWithReauth,
  };

  if (!registerReady && !credentialsReady) return;

  function reloadPage() {
    if (global.location && typeof global.location.reload === "function") {
      global.location.reload();
    }
  }

  function handleSuccess(button) {
    resetButton(button);
    try {
      if (typeof global.syncAuthMenuMode === "function") {
        global.syncAuthMenuMode();
      }
    } catch (err) {}
    reloadPage();
  }

  // 捕获阶段监听（capture=true）：撤销按钮可能在被 stopPropagation 的容器里，
  // 冒泡阶段收不到点击，故在捕获阶段接管（未被托管的撤销按钮）。
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;

    var revokeButton = target.closest(REVOKE_SELECTOR);
    if (!revokeButton) return;
    // 调用方自带处理器时（个人资料面板），交给调用方，避免撤销被触发两次。
    if (revokeButton.getAttribute("data-passkey-revoke-managed") !== null) return;
    event.preventDefault();
    if (revokeButton.disabled) return;
    revokeWithReauth(revokeButton.getAttribute("data-passkey-revoke") || "", {
      triggerButton: revokeButton,
    });
  }, true);
})((typeof window !== "undefined" ? window : globalThis));
