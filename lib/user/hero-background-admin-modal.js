(function () {
  "use strict";

  var template =
    '<div class="profile-modal-overlay" id="heroBgAdminOverlay" aria-hidden="true">' +
      '<div class="profile-modal-sheet hero-bg-admin-sheet" role="dialog" aria-modal="true" aria-labelledby="heroBgAdminTitle">' +
        '<button type="button" class="profile-modal-close" id="heroBgAdminCloseBtn" aria-label="关闭">&times;</button>' +
        '<div class="user-list-modal-head">' +
          '<h2 id="heroBgAdminTitle" class="user-list-modal-title">网站背景</h2>' +
        '</div>' +
        '<div class="hero-bg-admin-body">' +
          '<div class="hero-bg-admin-section">' +
            '<h3>轮换设置</h3>' +
            '<div class="hero-bg-admin-row">' +
              '<label>间隔(秒)<input type="number" id="heroBgRotateSec" min="5" step="1" value="30" /></label>' +
              '<label>淡入(ms)<input type="number" id="heroBgTransitionMs" min="0" step="50" value="800" /></label>' +
              '<label>模式<select id="heroBgPlaybackMode"><option value="sequential">顺序</option><option value="random">随机</option></select></label>' +
              '<button type="button" class="hero-bg-admin-btn hero-bg-admin-btn--primary" id="heroBgSaveConfigBtn">保存设置</button>' +
            '</div>' +
          '</div>' +
          '<div class="hero-bg-admin-section">' +
            '<h3>上传背景</h3>' +
            '<div class="hero-bg-admin-row">' +
              '<label>类型<select id="heroBgUploadType"><option value="video">视频</option><option value="image">图片</option></select></label>' +
              '<label>电脑端<input type="file" id="heroBgUploadFile" accept="video/mp4,video/webm,video/quicktime,image/*" /></label>' +
              '<label>封面<input type="file" id="heroBgUploadPoster" accept="image/*" /></label>' +
            '</div>' +
            '<div class="hero-bg-admin-row" style="margin-top:10px">' +
              '<label>手机端<input type="file" id="heroBgUploadFileMobile" accept="video/mp4,video/webm,video/quicktime,image/*" /></label>' +
              '<label>手机封面<input type="file" id="heroBgUploadPosterMobile" accept="image/*" /></label>' +
            '</div>' +
            '<div class="hero-bg-admin-row" style="margin-top:10px">' +
              '<label>标题<input type="text" id="heroBgUploadTitle" placeholder="首页大标题（可选）" /></label>' +
              '<label>副标题<input type="text" id="heroBgUploadSubtitle" placeholder="副标题（可选）" /></label>' +
              '<button type="button" class="hero-bg-admin-btn hero-bg-admin-btn--primary" id="heroBgUploadBtn">上传</button>' +
            '</div>' +
          '</div>' +
          '<div class="hero-bg-admin-section">' +
            '<h3>背景列表</h3>' +
            '<div class="hero-bg-admin-status" id="heroBgAdminStatus"></div>' +
            '<div class="hero-bg-admin-list" id="heroBgAdminList"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  var container = document.createElement("div");
  container.innerHTML = template;
  document.body.appendChild(container.firstElementChild);

  var overlay = document.getElementById("heroBgAdminOverlay");
  var closeBtn = document.getElementById("heroBgAdminCloseBtn");
  var statusEl = document.getElementById("heroBgAdminStatus");
  var listEl = document.getElementById("heroBgAdminList");
  var rotateSecEl = document.getElementById("heroBgRotateSec");
  var transitionMsEl = document.getElementById("heroBgTransitionMs");
  var playbackModeEl = document.getElementById("heroBgPlaybackMode");
  var saveConfigBtn = document.getElementById("heroBgSaveConfigBtn");
  var uploadTypeEl = document.getElementById("heroBgUploadType");
  var uploadFileEl = document.getElementById("heroBgUploadFile");
  var uploadPosterEl = document.getElementById("heroBgUploadPoster");
  var uploadFileMobileEl = document.getElementById("heroBgUploadFileMobile");
  var uploadPosterMobileEl = document.getElementById("heroBgUploadPosterMobile");
  var uploadTitleEl = document.getElementById("heroBgUploadTitle");
  var uploadSubtitleEl = document.getElementById("heroBgUploadSubtitle");
  var uploadBtn = document.getElementById("heroBgUploadBtn");
  var bodyOverflowPrev = "";

  function getLoggedInPhone() {
    try {
      var raw = localStorage.getItem("leng_user");
      if (!raw) return "";
      var user = JSON.parse(raw);
      return String(user.phone || user.mobile || "").replace(/\D/g, "");
    } catch (e) {
      return "";
    }
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.remove("is-error", "is-ok");
    if (kind === "error") statusEl.classList.add("is-error");
    if (kind === "ok") statusEl.classList.add("is-ok");
  }

  function adminUrl(query) {
    var phone = getLoggedInPhone();
    var q = "phone=" + encodeURIComponent(phone);
    if (query) q += "&" + query;
    return "/api/hero-backgrounds-admin?" + q;
  }

  function apiJson(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || data.success !== true) {
          var msg = (data && data.error) || "请求失败 (" + res.status + ")";
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function renderPreview(mediaEl, item) {
    mediaEl.innerHTML = "";
    if (!item || !item.media_url) {
      var span = document.createElement("span");
      span.textContent = "无预览";
      mediaEl.appendChild(span);
      return;
    }
    if (item.media_type === "image") {
      var img = document.createElement("img");
      img.src = item.poster_url || item.media_url;
      img.alt = "";
      mediaEl.appendChild(img);
      return;
    }
    var video = document.createElement("video");
    video.src = item.media_url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    if (item.poster_url) video.poster = item.poster_url;
    mediaEl.appendChild(video);
  }

  function renderList(items) {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!items || !items.length) {
      listEl.innerHTML = '<p class="hero-bg-admin-status">暂无背景，请上传视频或图片。</p>';
      return;
    }
    items.forEach(function (item) {
      var card = document.createElement("div");
      card.className = "hero-bg-admin-card" + (item.is_active ? "" : " is-inactive");

      var preview = document.createElement("div");
      preview.className = "hero-bg-admin-preview";
      renderPreview(preview, item);

      var meta = document.createElement("div");
      meta.className = "hero-bg-admin-meta";
      meta.innerHTML =
        "<strong>" +
        (item.title || "(无标题)") +
        "</strong>" +
        "<div>" +
        (item.media_type === "video" ? "视频" : "图片") +
        " · 排序 " +
        item.sort_order +
        (item.is_active ? " · 已启用" : " · 已停用") +
        "</div>" +
        (item.subtitle ? "<div>" + item.subtitle + "</div>" : "") +
        "<code>" +
        item.r2_key +
        "</code>";

      var actions = document.createElement("div");
      actions.className = "hero-bg-admin-actions";

      var toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "hero-bg-admin-btn";
      toggleBtn.textContent = item.is_active ? "停用" : "启用";
      toggleBtn.addEventListener("click", function () {
        patchItem(item.id, { is_active: !item.is_active });
      });

      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "hero-bg-admin-btn";
      upBtn.textContent = "上移";
      upBtn.addEventListener("click", function () {
        patchItem(item.id, { sort_order: item.sort_order - 1 });
      });

      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "hero-bg-admin-btn";
      downBtn.textContent = "下移";
      downBtn.addEventListener("click", function () {
        patchItem(item.id, { sort_order: item.sort_order + 1 });
      });

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "hero-bg-admin-btn";
      editBtn.textContent = "改标题";
      editBtn.addEventListener("click", function () {
        var title = window.prompt("首页大标题", item.title || "");
        if (title == null) return;
        var subtitle = window.prompt("副标题", item.subtitle || "");
        if (subtitle == null) return;
        patchItem(item.id, { title: title, subtitle: subtitle });
      });

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "hero-bg-admin-btn";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", function () {
        if (!window.confirm("确定停用该背景？")) return;
        deleteItem(item.id);
      });

      actions.appendChild(toggleBtn);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      card.appendChild(preview);
      card.appendChild(meta);
      card.appendChild(actions);
      listEl.appendChild(card);
    });
  }

  function applyConfig(config) {
    if (!config) return;
    if (rotateSecEl) rotateSecEl.value = String(Math.round((config.rotate_interval_ms || 30000) / 1000));
    if (transitionMsEl) transitionMsEl.value = String(config.transition_ms || 800);
    if (playbackModeEl) playbackModeEl.value = config.playback_mode === "random" ? "random" : "sequential";
  }

  function loadAdminData() {
    var phone = getLoggedInPhone();
    if (!phone) {
      setStatus("请先登录运维账号。", "error");
      return Promise.resolve();
    }
    setStatus("加载中…");
    return apiJson("GET", adminUrl())
      .then(function (data) {
        applyConfig(data.config);
        renderList(data.items || []);
        setStatus("共 " + (data.items || []).length + " 条背景。", "ok");
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function patchItem(id, patch) {
    var phone = getLoggedInPhone();
    var body = Object.assign({ phone: phone, id: id }, patch);
    setStatus("保存中…");
    return apiJson("PATCH", "/api/hero-backgrounds-admin", body)
      .then(function () {
        return loadAdminData();
      })
      .then(function () {
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function deleteItem(id) {
    var phone = getLoggedInPhone();
    setStatus("删除中…");
    return apiJson("DELETE", "/api/hero-backgrounds-admin", { phone: phone, id: id })
      .then(function () {
        return loadAdminData();
      })
      .then(function () {
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function saveConfig() {
    var phone = getLoggedInPhone();
    var sec = Number(rotateSecEl && rotateSecEl.value);
    var transition = Number(transitionMsEl && transitionMsEl.value);
    setStatus("保存设置…");
    return apiJson("PUT", "/api/hero-backgrounds-admin", {
      phone: phone,
      config: {
        rotate_interval_ms: sec > 0 ? sec * 1000 : 30000,
        transition_ms: transition >= 0 ? transition : 800,
        playback_mode: playbackModeEl ? playbackModeEl.value : "sequential",
      },
    })
      .then(function () {
        setStatus("轮换设置已保存。", "ok");
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function uploadMedia() {
    var phone = getLoggedInPhone();
    var file = uploadFileEl && uploadFileEl.files && uploadFileEl.files[0];
    if (!file) {
      setStatus("请选择要上传的媒体文件。", "error");
      return;
    }
    var form = new FormData();
    form.append("phone", phone);
    form.append("file", file);
    form.append("media_type", uploadTypeEl ? uploadTypeEl.value : "video");
    if (uploadTitleEl && uploadTitleEl.value) form.append("title", uploadTitleEl.value.trim());
    if (uploadSubtitleEl && uploadSubtitleEl.value) form.append("subtitle", uploadSubtitleEl.value.trim());
    if (uploadPosterEl && uploadPosterEl.files && uploadPosterEl.files[0]) {
      form.append("poster", uploadPosterEl.files[0]);
    }
    if (uploadFileMobileEl && uploadFileMobileEl.files && uploadFileMobileEl.files[0]) {
      form.append("file_mobile", uploadFileMobileEl.files[0]);
    }
    if (uploadPosterMobileEl && uploadPosterMobileEl.files && uploadPosterMobileEl.files[0]) {
      form.append("poster_mobile", uploadPosterMobileEl.files[0]);
    }
    uploadBtn.disabled = true;
    setStatus("上传中，请稍候…");
    apiJson("POST", "/api/hero-backgrounds-admin", form)
      .then(function () {
        if (uploadFileEl) uploadFileEl.value = "";
        if (uploadPosterEl) uploadPosterEl.value = "";
        if (uploadFileMobileEl) uploadFileMobileEl.value = "";
        if (uploadPosterMobileEl) uploadPosterMobileEl.value = "";
        if (uploadTitleEl) uploadTitleEl.value = "";
        if (uploadSubtitleEl) uploadSubtitleEl.value = "";
        setStatus("上传成功。", "ok");
        return loadAdminData();
      })
      .then(function () {
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      })
      .finally(function () {
        uploadBtn.disabled = false;
      });
  }

  function openHeroBgAdminModal() {
    if (!overlay) return;
    if (typeof window.userHasOpsMenuAccess === "function" && !window.userHasOpsMenuAccess()) {
      alert("无系统运维权限");
      return;
    }
    bodyOverflowPrev = document.body.style.overflow || "";
    document.body.style.overflow = "hidden";
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    loadAdminData();
  }

  function closeHeroBgAdminModal() {
    if (!overlay) return;
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = bodyOverflowPrev;
  }

  if (closeBtn) closeBtn.addEventListener("click", closeHeroBgAdminModal);
  if (overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeHeroBgAdminModal();
    });
  }
  if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveConfig);
  if (uploadBtn) uploadBtn.addEventListener("click", uploadMedia);

  var menuBtn = document.getElementById("topNavHeroBackground");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      openHeroBgAdminModal();
    });
  }

  window.openHeroBgAdminModal = openHeroBgAdminModal;
  window.closeHeroBgAdminModal = closeHeroBgAdminModal;
})();
