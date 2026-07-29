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

  /**
   * 临时：只要登录成功就显示/可用「系统运维」。
   * 这几天调试用；正式收紧时改回 false。
   */
  window.OPS_TEMP_OPEN_TO_ANY_LOGIN = true;

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
    if (window.OPS_TEMP_OPEN_TO_ANY_LOGIN) {
      try {
        if (localStorage.getItem("leng_logged_in") === "1") return true;
      } catch (eTemp) {}
    }
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

  window.unlockProfileNavPersist = function () {
    try {
      localStorage.setItem("leng_profile_unlocked", "1");
    } catch (e) {}
  };

  window.persistRegistrationReceiptFailure = function () {};

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
      localStorage.setItem("leng_profile_unlocked", "1");
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
      localStorage.removeItem("leng_profile_unlocked");
      localStorage.removeItem("leng_user");
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

  /** —— 个人资料弹窗依赖（与旧站 registration receipt 对齐，数据源为 leng_user） —— */
  window.ENABLE_AVATAR_DEBUG_TO_DOCK = window.ENABLE_AVATAR_DEBUG_TO_DOCK || false;
  window.DBG_A0002_2 = window.DBG_A0002_2 || "A0002-2";
  window.dbgEmitNetworkUpdateKvHint = window.dbgEmitNetworkUpdateKvHint || function () {};
  window.emitAvatarDiagnosticsToDebugDock =
    window.emitAvatarDiagnosticsToDebugDock || function () {};
  window.mergeAvatarHttpsFromDiagnostics =
    window.mergeAvatarHttpsFromDiagnostics ||
    function (val) {
      return val;
    };
  window.applyHomeComposerAvatarFromProfileSave =
    window.applyHomeComposerAvatarFromProfileSave || function () {};
  window.syncHomeComposerAvatar = window.syncHomeComposerAvatar || function () {};

  window.showBriefAppHint = function (msg) {
    try {
      if (typeof window.loginDebugDockEmit === "function") {
        window.loginDebugDockEmit("log", "[提示] " + String(msg || ""));
      }
    } catch (e) {}
    alert(String(msg || ""));
  };

  window.refreshTopAuthChrome = function () {
    var u = window.__LENG_USER;
    var link = document.getElementById("topNavUserLogin");
    if (link) {
      if (u && (u.username || u.phone)) {
        link.textContent = u.username || u.phone || "已登录";
      }
    }
    if (typeof window.syncAuthMenuMode === "function") {
      window.syncAuthMenuMode();
    }
    if (typeof window.syncOpsMenuVisibility === "function") {
      window.syncOpsMenuVisibility();
    }
  };

  window.normalizeStoredPlainPasswordForProfile = function (pwd) {
    var p = String(pwd == null ? "" : pwd);
    if (!p) return "";
    if (p.indexOf("$") === 0) return "";
    if (p.length > 80) return "";
    return p;
  };

  window.applyPinyinInitialsToEl = function (name, el) {
    if (!el) return;
    var s = String(name || "").trim();
    var ch = "";
    for (var i = s.length - 1; i >= 0; i--) {
      if (/[\u4e00-\u9fff]/.test(s.charAt(i))) {
        ch = s.charAt(i);
        break;
      }
    }
    if (!ch && s) ch = s.charAt(0).toUpperCase();
    el.textContent = ch || "?";
  };

  window.getCurrentAvatarOwnerId = function () {
    var u = window.__LENG_USER;
    if (u && u.uuid) return String(u.uuid);
    if (u && u.user_data && u.user_data.other_data) {
      return String(u.user_data.other_data);
    }
    if (u && u.phone) return "phone-" + String(u.phone);
    return "";
  };

  window.getReceiptAvatarUrl = function (rec) {
    var v = rec && rec.value;
    return (v && v.avatar_url && String(v.avatar_url)) || "";
  };

  window.getReceiptAvatarDataUrl = function (rec) {
    var v = rec && rec.value;
    return (v && v.avatar_data_url && String(v.avatar_data_url)) || "";
  };

  window.readStoredProfileAvatar = function (phone, ownerId) {
    try {
      var k = "L_ENG_profile_avatar_" + String(ownerId || phone || "");
      return localStorage.getItem(k) || "";
    } catch (e) {
      return "";
    }
  };

  window.writeStoredProfileAvatar = function (phone, ownerId, url) {
    try {
      var k = "L_ENG_profile_avatar_" + String(ownerId || phone || "");
      if (url) localStorage.setItem(k, String(url));
      else localStorage.removeItem(k);
    } catch (e) {}
  };

  window.clearStoredProfileAvatar = function (phone, ownerId) {
    window.writeStoredProfileAvatar(phone, ownerId, "");
  };

  window.readRegistrationReceipt = function () {
    try {
      if (localStorage.getItem("leng_logged_in") !== "1") return null;
      var raw = localStorage.getItem("leng_user");
      if (!raw) return null;
      var u = JSON.parse(raw);
      if (!u || !u.phone) return null;
      var ud = u.user_data && typeof u.user_data === "object" ? u.user_data : {};
      var phone = String(u.phone).replace(/\D/g, "") || String(u.phone);
      return {
        version: 1,
        keyStr: "phone:" + phone,
        value: {
          name: String(u.username || ud.name || ""),
          email: String(u.email || ud.email || ""),
          pwd: String(u.password || ""),
          avatar_url: String(ud.avatar_url || u.avatar_url || ""),
          avatar_data_url: String(ud.avatar_data_url || u.avatar_data_url || ""),
          avatar_r2_key: String(ud.avatar_r2_key || ""),
          other_data: String(ud.other_data || u.uuid || ""),
        },
        metadata: {
          type: ud.type,
          group: ud.group,
          g_role: ud.g_role,
          status: ud.status,
        },
        pendingKvSave: false,
        kvSaveOk: true,
        updatedAt: Date.now(),
      };
    } catch (e) {
      return null;
    }
  };

  window.isRegistrationReceiptActive = function (rec) {
    try {
      if (localStorage.getItem("leng_logged_in") !== "1") return false;
    } catch (e) {
      return false;
    }
    return !!(rec && rec.keyStr && rec.value && rec.kvSaveOk !== false);
  };

  window.writeRegistrationReceipt = function (rec) {
    if (!rec || !rec.keyStr || !rec.value) return;
    var phone =
      rec.keyStr.indexOf("phone:") === 0 ? rec.keyStr.slice(6) : String(rec.keyStr);
    var v = rec.value || {};
    var prev = {};
    try {
      prev = JSON.parse(localStorage.getItem("leng_user") || "{}") || {};
    } catch (e) {
      prev = {};
    }
    var prevUd =
      prev.user_data && typeof prev.user_data === "object" ? prev.user_data : {};
    var meta = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
    var user = {
      user_id: phone,
      phone: phone,
      username: String(v.name || ""),
      email: String(v.email || ""),
      password: String(v.pwd != null ? v.pwd : prev.password || ""),
      uuid: String(v.other_data || prev.uuid || ""),
      user_data: Object.assign({}, prevUd, {
        name: v.name,
        email: v.email,
        avatar_url: v.avatar_url,
        avatar_data_url: v.avatar_data_url,
        avatar_r2_key: v.avatar_r2_key,
        other_data: v.other_data || prevUd.other_data || prev.uuid || "",
        type: meta.type != null ? meta.type : prevUd.type,
        group: meta.group != null ? meta.group : prevUd.group,
        g_role: meta.g_role != null ? meta.g_role : prevUd.g_role,
        status: meta.status != null ? meta.status : prevUd.status,
      }),
    };
    try {
      localStorage.setItem("leng_user", JSON.stringify(user));
      localStorage.setItem("leng_logged_in", "1");
    } catch (e2) {}
    window.__LENG_USER = user;
    window.applyCurrentUserGlobals(user.user_data);
    window.refreshTopAuthChrome();
  };

  window.persistRegistrationReceiptSuccess = function (keyStr, value, metadata) {
    window.writeRegistrationReceipt({
      version: 1,
      keyStr: keyStr,
      value: value || {},
      metadata: metadata || {},
      pendingKvSave: false,
      kvSaveOk: true,
      updatedAt: Date.now(),
    });
  };

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
