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

  /** 与 KV metadata.type 掩位一致（见 DVDoc KV 设计） */
  window.USER_TYPE_SUPERUSER = 0x01; // 00000001 超级用户
  window.USER_TYPE_DBG_STF = 0x02; // 00000010 网站技术调试员
  window.USER_TYPE_CNT_MGR = 0x04; // 00000100 内容审核总负责
  window.USER_TYPE_CNT_STF = 0x08; // 00001000 内容审核人员
  window.USER_TYPE_UA = 0x10; // 00010000 A类用户
  window.USER_TYPE_UB = 0x20; // 00100000 B类用户
  window.USER_TYPE_UC = 0x40; // 01000000 C类用户

  /** 当前：系统运维入口 = 超管 | 技术调试员；今后可扩内容岗 */
  window.USER_TYPE_OPS_MENU =
    window.USER_TYPE_SUPERUSER | window.USER_TYPE_DBG_STF;

  function parseUserTypeMask(userData) {
    if (!userData || userData.type == null || userData.type === "") return 0;
    var raw = String(userData.type).trim();
    if (/^[01]+$/.test(raw)) return parseInt(raw, 2) || 0;
    var n = Number(userData.type);
    return isFinite(n) ? n >>> 0 : 0;
  }

  function parseUserGRole(userData) {
    return userData && Number(userData.g_role) === 1 ? 1 : 0;
  }

  function parseUserGroup(userData) {
    return userData && userData.group != null ? String(userData.group) : "";
  }

  /** 登录后写入文档约定的全局变量 */
  window.applyCurrentUserGlobals = function (userData) {
    var data = userData && typeof userData === "object" ? userData : {};
    var typeMask = parseUserTypeMask(data);
    var gRole = parseUserGRole(data);
    var group = parseUserGroup(data);
    window.__currentUserGroup = group;
    window.__currentUserRole = { type: typeMask, g_role: gRole };
    window.__currentUserTypeMask = typeMask;
    return window.__currentUserRole;
  };

  window.clearCurrentUserGlobals = function () {
    window.__currentUserGroup = "";
    window.__currentUserRole = { type: 0, g_role: 0 };
    window.__currentUserTypeMask = 0;
  };

  window.userHasOpsMenuAccess = function (roleOrMask) {
    var mask = 0;
    if (typeof roleOrMask === "number") {
      mask = roleOrMask >>> 0;
    } else if (roleOrMask && typeof roleOrMask === "object") {
      mask = Number(roleOrMask.type) || 0;
    } else if (window.__currentUserRole) {
      mask = Number(window.__currentUserRole.type) || 0;
    }
    return (mask & window.USER_TYPE_OPS_MENU) !== 0;
  };

  window.syncOpsMenuVisibility = function () {
    var allow =
      localStorage.getItem("leng_logged_in") === "1" &&
      window.userHasOpsMenuAccess();
    document.querySelectorAll(".auth-menu-ops").forEach(function (el) {
      el.hidden = !allow;
    });
    if (!allow) {
      var opsMenu = document.getElementById("ops-menu");
      var opsToggle = document.getElementById("topNavSystemOps");
      if (opsMenu) opsMenu.classList.remove("open");
      if (opsToggle) opsToggle.setAttribute("aria-expanded", "false");
    }
  };

  window.persistRegistrationReceiptSuccess = function () {};
  window.persistRegistrationReceiptFailure = function () {};
  window.unlockProfileNavPersist = function () {
    try {
      localStorage.setItem("leng_profile_unlocked", "1");
    } catch (e) {}
  };

  /** 仅记录超管运维解锁状态；顶栏运维入口改由「系统运维」下拉控制，不再弹出旧运维条 */
  window.setAdminMenusVisible = function (visible) {
    try {
      sessionStorage.setItem(
        "L_ENG_admin_menu_unlocked_v1",
        visible ? "1" : "0"
      );
    } catch (e) {}
    var nav = document.getElementById("userAdminNav");
    if (nav) nav.hidden = true;
  };

  window.markProfileNavUnlockedByLogin = function (
    phone,
    username,
    email,
    password,
    uuid,
    userData
  ) {
    var data = userData || {};
    var user = {
      user_id: phone,
      phone: phone,
      username: username || "",
      email: email || "",
      password: password || "",
      uuid: uuid || "",
      user_data: data,
    };
    window.__LENG_USER = user;
    window.applyCurrentUserGlobals(data);
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
    var typeMask = Number(window.__currentUserTypeMask) || 0;
    var isSuper = (typeMask & window.USER_TYPE_SUPERUSER) !== 0;
    /** 超管登录后直接展开运维条；调试员先靠「系统运维」入口再开 */
    window.setAdminMenusVisible(!!isSuper);
    if (typeof window.syncAuthMenuMode === "function") {
      window.syncAuthMenuMode();
    }
    if (typeof window.syncOpsMenuVisibility === "function") {
      window.syncOpsMenuVisibility();
    }
  };

  /** 顶栏登出：先恢复「登录」菜单；会话/收据清理后续再完善 */
  window.clearProfileNavOnLogout = function () {
    try {
      localStorage.removeItem("leng_logged_in");
    } catch (e) {}
    window.__LENG_USER = null;
    window.clearCurrentUserGlobals();
    window.setAdminMenusVisible(false);
    var loginLink = document.getElementById("topNavUserLogin");
    if (loginLink) {
      var lang = document.documentElement.lang === "en" ? "en" : "zh";
      loginLink.textContent = lang === "en" ? "Login" : "登录";
    }
    if (typeof window.syncTopMoreMenuAccess === "function") {
      window.syncTopMoreMenuAccess();
    }
    if (typeof window.syncAuthMenuMode === "function") {
      window.syncAuthMenuMode();
    }
    if (typeof window.syncOpsMenuVisibility === "function") {
      window.syncOpsMenuVisibility();
    }
    try {
      if (window.L_ENG_Register) {
        if (typeof window.L_ENG_Register.close === "function") {
          window.L_ENG_Register.close();
        }
        if (typeof window.L_ENG_Register.closeNew === "function") {
          window.L_ENG_Register.closeNew();
        }
      }
    } catch (e2) {}
  };

  window.clearCurrentUserGlobals();

  try {
    var raw = localStorage.getItem("leng_user");
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.phone) {
        window.__LENG_USER = parsed;
        window.applyCurrentUserGlobals(parsed.user_data || {});
        var link = document.getElementById("topNavUserLogin");
        if (link && localStorage.getItem("leng_logged_in") === "1") {
          link.textContent = parsed.username || parsed.phone || "已登录";
        }
        var unlocked =
          sessionStorage.getItem("L_ENG_admin_menu_unlocked_v1") === "1";
        var typeMask = Number(window.__currentUserTypeMask) || 0;
        var isSuper = (typeMask & window.USER_TYPE_SUPERUSER) !== 0;
        window.setAdminMenusVisible(unlocked && isSuper);
      }
    }
  } catch (e) {}

  if (typeof window.syncAuthMenuMode === "function") {
    window.syncAuthMenuMode();
  }
  if (typeof window.syncOpsMenuVisibility === "function") {
    window.syncOpsMenuVisibility();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      if (typeof window.syncAuthMenuMode === "function") {
        window.syncAuthMenuMode();
      }
      if (typeof window.syncOpsMenuVisibility === "function") {
        window.syncOpsMenuVisibility();
      }
    });
  }
})();
