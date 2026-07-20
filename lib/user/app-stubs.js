(function () {
  "use strict";

  [
    "topMoreDigitTpl",
    "userListModalCloseBtn",
    "avatarManageModalCloseBtn",
    "avatarManageModalOverlay",
    "avatarManageSaveBtn",
    "avatarManageDeleteBtn",
    "avatarManageResetBtn",
    "avatarManageDropZone",
    "avatarManagePreviewImg",
    "avatarManagePlaceholder",
    "avatarManageIsBgCheckbox",
    "avatarManagePendingThumbDataUrl",
    "avatarManagePendingIsRound",
    "avatarManageModalBodyOverflowPrev",
    "avatarManageSelectedSaved",
    "avatarSavedRoundStrip",
    "avatarSavedSquareStrip",
  ].forEach(function (name) {
    if (typeof window[name] === "undefined") {
      window[name] = null;
    }
  });

  window.avatarSavedRoundList = window.avatarSavedRoundList || [];
  window.avatarSavedSquareList = window.avatarSavedSquareList || [];
  window.syncHomeComposerAvatar = window.syncHomeComposerAvatar || function () {};

  window.dbgTagged = function (code, body) {
    return "[" + String(code || "dbg") + "] " + String(body || "");
  };

  window.loginDebugDockEmit = function (level, message) {
    var fn = console[level] || console.log;
    fn.call(console, message);
  };

  window.bindPasswordHalfwidthInput = function (el) {
    if (!el) return;
    el.addEventListener("input", function () {
      var v = el.value;
      if (typeof v.normalize === "function") {
        var n = v.normalize("NFKC");
        if (n !== v) el.value = n;
      }
    });
  };

  window.stopPolling = function () {
    if (window.qrTimer) {
      clearInterval(window.qrTimer);
      window.qrTimer = null;
    }
  };

  if (typeof window.qrTimer === "undefined") {
    window.qrTimer = null;
  }

  window.persistRegistrationReceiptSuccess = function () {};
  window.persistRegistrationReceiptFailure = function () {};
  window.unlockProfileNavPersist = function () {
    try {
      localStorage.setItem("leng_profile_unlocked", "1");
    } catch (e) {}
  };

  window.setAdminMenusVisible = function (visible) {
    try {
      sessionStorage.setItem(
        "L_ENG_admin_menu_unlocked_v1",
        visible ? "1" : "0"
      );
    } catch (e) {}
    var nav = document.getElementById("userAdminNav");
    if (nav) nav.hidden = !visible;
  };

  window.markProfileNavUnlockedByLogin = function (
    phone,
    username,
    email,
    password,
    uuid,
    userData
  ) {
    var user = {
      user_id: phone,
      phone: phone,
      username: username || "",
      email: email || "",
      password: password || "",
      uuid: uuid || "",
      user_data: userData || {},
    };
    window.__LENG_USER = user;
    window.__currentUserRole = {
      type: userData && userData.type != null ? Number(userData.type) : 0,
    };
    try {
      localStorage.setItem("leng_user", JSON.stringify(user));
      localStorage.setItem("leng_logged_in", "1");
    } catch (e) {}
    var loginLink = document.getElementById("topNavUserLogin");
    if (loginLink) {
      loginLink.textContent = username || phone || "已登录";
    }
    if (typeof window.syncTopMoreMenuAccess === "function") {
      window.syncTopMoreMenuAccess();
    }
    var isSuper =
      userData && userData.type != null && (Number(userData.type) & 1) !== 0;
    window.setAdminMenusVisible(!!isSuper);
  };

  try {
    var raw = localStorage.getItem("leng_user");
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.phone) {
        window.__LENG_USER = parsed;
        window.__currentUserRole = {
          type:
            parsed.user_data && parsed.user_data.type != null
              ? Number(parsed.user_data.type)
              : 0,
        };
        var link = document.getElementById("topNavUserLogin");
        if (link && localStorage.getItem("leng_logged_in") === "1") {
          link.textContent = parsed.username || parsed.phone || "已登录";
        }
        var unlocked =
          sessionStorage.getItem("L_ENG_admin_menu_unlocked_v1") === "1";
        var isSuper =
          parsed.user_data && parsed.user_data.type != null
            ? (Number(parsed.user_data.type) & 1) !== 0
            : false;
        window.setAdminMenusVisible(unlocked && isSuper);
      }
    }
  } catch (e) {}
})();
