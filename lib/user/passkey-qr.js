/**
 * Passkey QR 登录 · 桌面控制器。
 * init → 本地渲染二维码（不外发 sid）→ 倒计时 → 轮询 → 检测到请求（掩码手机号短暂可见）
 * → 自动 claim 取一次性 token → setSessionCookie（真会话）→ 关闭弹层。
 */
(function (global) {
  "use strict";

  var POLL_INTERVAL_MS = 1500;
  /** 掩码手机号展示多久后自动 claim（保证用户能看清「谁在登录」） */
  var CLAIM_DELAY_MS = 500;
  var state = {
    sid: "",
    qrUrl: "",
    expiresAt: 0,
    pollTimer: null,
    tickTimer: null,
    claimTimer: null,
    polling: false,
    /** claim 锁：一次会话只允许 claim 一次（自动 claim 与其它调用并发时也只走一遍） */
    claiming: false,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function authApi() {
    return global.HZDVPasskeyAuth;
  }

  function setStatus(text, kind) {
    var status = el("registerLoginStatusPasskey");
    if (!status) return;
    status.textContent = text || "";
    status.classList.remove("is-ok", "is-error", "is-pending");
    if (kind) status.classList.add("is-" + kind);
  }

  function setAccount(text) {
    var box = el("registerPasskeyQrAccount");
    if (!box) return;
    box.textContent = text || "";
    box.hidden = !text;
  }

  function stop() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.tickTimer) clearInterval(state.tickTimer);
    if (state.claimTimer) clearTimeout(state.claimTimer);
    state.pollTimer = null;
    state.tickTimer = null;
    state.claimTimer = null;
    state.polling = false;
  }

  /** 登录弹层未打开时停止轮询/倒计时，避免后台空转。 */
  function isModalOpen() {
    var panel = document.getElementById("registerPanel");
    if (!panel) return true;
    return !!panel.classList.contains("show");
  }

  function renderQr(url) {
    var box = el("registerPasskeyQrBox");
    if (!box) return false;
    var factory = global.qrcode;
    if (typeof factory !== "function") {
      setStatus("二维码组件加载失败，请刷新页面重试。", "error");
      return false;
    }
    try {
      var qr = factory(0, "M");
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag({
        cellSize: 4,
        margin: 2,
        scalable: true,
        alt: { text: "用手机扫码登录 HZDV" },
        title: { text: "HZDV 通行密钥登录" },
      });
      var svg = box.querySelector("svg");
      if (svg) {
        svg.style.width = "160px";
        svg.style.height = "160px";
        svg.style.display = "block";
      }
      return true;
    } catch (e) {
      setStatus("二维码生成失败，请刷新页面重试。", "error");
      return false;
    }
  }

  function startCountdown() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(function () {
      if (!isModalOpen()) {
        stop();
        return;
      }
      var box = el("registerPasskeyQrCountdown");
      var remain = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
      if (box) box.textContent = remain > 0 ? "二维码将在 " + remain + " 秒后刷新" : "";
      if (remain <= 0) {
        stop();
        start();
      }
    }, 1000);
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.polling = true;
    state.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    poll();
  }

  async function poll() {
    if (!state.polling || !state.sid) return;
    if (!isModalOpen()) {
      stop();
      return;
    }
    var auth = authApi();
    if (!auth || typeof auth.fetchJSON !== "function") return;
    try {
      var data = await auth.fetchJSON("/api/passkey/qr/poll?sid=" + encodeURIComponent(state.sid));
      var status = data && data.status;
      if (status === "pending") return;
      if (status === "ready") {
        state.polling = false;
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
        var masked = (data.user && data.user.userKeyMasked) || "";
        setAccount(masked ? "检测到登录请求：" + masked : "检测到登录请求");
        setStatus("正在完成登录…", "pending");
        // 产品拍板：不再让用户点「确认登录」。掩码手机号短暂可见后自动 claim。
        if (state.claimTimer) clearTimeout(state.claimTimer);
        state.claimTimer = setTimeout(function () {
          state.claimTimer = null;
          if (!isModalOpen()) {
            // 弹层已被关掉 → 放弃本次自动登录，不要在用户无感知的情况下登进去
            setAccount("");
            return;
          }
          claimAndFinish();
        }, CLAIM_DELAY_MS);
        return;
      }
      if (status === "success") {
        state.polling = false;
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
        setStatus("登录会话已交接，请重新扫码。", "error");
        return;
      }
      if (status === "expired") {
        stop();
        start();
        return;
      }
      // unknown / 其它
      state.polling = false;
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
      setStatus("二维码已失效，请重新扫码。", "error");
    } catch (err) {
      // 轮询失败不致命：继续轮询直到超时
    }
  }

  async function start() {
    stop();
    // 新会话：解锁 claim（stop 已清掉上一轮挂起的自动 claim 定时器）
    state.claiming = false;
    setAccount("");
    var auth = authApi();
    if (!auth || typeof auth.fetchJSON !== "function") {
      setStatus("功能暂不可用，请稍后再试。", "error");
      return;
    }
    setStatus("正在生成二维码…", "pending");
    try {
      var data = await auth.fetchJSON("/api/passkey/qr/init", { method: "POST" });
      if (!data || !data.session_id || !data.qr_url) throw new Error("bad_init");
      state.sid = String(data.session_id);
      state.qrUrl = String(data.qr_url);
      state.expiresAt = Number(data.expires_at) || Date.now() + 300000;
      if (!renderQr(state.qrUrl)) return;
      setStatus("请使用手机扫码登录。", "pending");
      startCountdown();
      startPolling();
    } catch (err) {
      var status = err && err.status;
      if (status === 503) {
        setStatus("功能暂不可用（服务端尚未启用扫码登录）。", "error");
      } else if (status === 429) {
        setStatus("尝试过于频繁，请稍后再试。", "error");
      } else {
        setStatus("二维码生成失败，请稍后再试。", "error");
      }
    }
  }

  /**
   * 桌面端登录收尾：写入服务端签发的会话 Cookie + 复用既有客户端登录态逻辑 + 关闭弹层。
   * @param {Object} user {userKey, userUuid, stored_username, stored_email, user_data}
   */
  function applyDesktopLogin(user) {
    var info = user || {};
    var phone = String(info.userKey || "").replace(/^phone:/, "");
    var uuid = String(info.userUuid || "");
    var userData = info.user_data && typeof info.user_data === "object" ? info.user_data : {};
    var username = String(info.stored_username || "").trim() || phone;
    var email = String(info.stored_email || "");
    var otherData = String(userData.other_data || uuid || "");
    if (typeof global.markProfileNavUnlockedByLogin === "function") {
      global.markProfileNavUnlockedByLogin(phone, username, email, "", otherData, userData);
    }
    if (global.L_ENG_Register && typeof global.L_ENG_Register.close === "function") {
      global.L_ENG_Register.close();
    }
    if (typeof global.syncAuthMenuMode === "function") global.syncAuthMenuMode();
  }

  /**
   * claim 一次性 sessionToken 并完成登录。
   * state.claiming 锁：保证一次会话只 claim 一次
   * （自动 claim、定时器与其它调用同时触发时也只有一次请求真正发出）。
   */
  async function claimAndFinish() {
    if (!state.sid) return;
    if (state.claiming) return;
    var auth = authApi();
    if (!auth || typeof auth.fetchJSON !== "function") return;
    state.claiming = true;
    setStatus("正在完成登录…", "pending");
    try {
      var data = await auth.fetchJSON("/api/passkey/qr/claim?sid=" + encodeURIComponent(state.sid), {
        method: "POST",
      });
      var token = data && data.sessionToken;
      if (!token) throw new Error("no_token");
      // 真会话：服务端签发的 token 写入 Cookie（hzdv_session）
      auth.setSessionCookie(token);
      stop();
      applyDesktopLogin((data && data.user) || {});
      setStatus("登录成功", "ok");
    } catch (err) {
      // 允许重试：解锁 claim，下次 ready/手动调用还能再走一遍
      state.claiming = false;
      setStatus("登录未完成，请重新扫码。", "error");
    }
  }

  /**
   * 兼容旧绑定：产品已改为「检测到请求即自动登录」，这里保留为转调 claim 的入口，
   * 不再有「确认登录」按钮。
   */
  function confirm() {
    return claimAndFinish();
  }

  global.HZDVPasskeyQr = {
    start: start,
    stop: stop,
    confirm: confirm,
    claim: claimAndFinish,
    applyDesktopLogin: applyDesktopLogin,
  };
})(typeof window !== "undefined" ? window : globalThis);
