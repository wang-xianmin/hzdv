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
          '<div class="hero-bg-admin-top">' +
            '<div class="hero-bg-admin-section">' +
              '<h3>轮换设置</h3>' +
              '<div class="hero-bg-admin-row">' +
                '<label>间隔(秒)<input type="number" id="heroBgRotateSec" min="5" step="1" value="30" /></label>' +
                '<label>淡入(ms)<input type="number" id="heroBgTransitionMs" min="0" step="50" value="800" /></label>' +
                '<label>模式<select id="heroBgPlaybackMode"><option value="sequential">顺序</option><option value="random">随机</option></select></label>' +
                '<button type="button" class="hero-bg-admin-btn hero-bg-admin-btn--primary" id="heroBgSaveConfigBtn">保存设置</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="hero-bg-admin-bottom">' +
            '<div class="hero-bg-admin-bottom-head">' +
              '<div class="hero-bg-admin-bottom-head-left">' +
                '<h3>背景列表</h3>' +
                '<button type="button" class="hero-bg-admin-btn hero-bg-admin-btn--primary" id="heroBgAddBtn">新增</button>' +
              '</div>' +
              '<div class="hero-bg-admin-status" id="heroBgAdminStatus"></div>' +
            '</div>' +
            '<div class="hero-bg-admin-table-wrap" id="heroBgAdminTableWrap">' +
              '<table class="hero-bg-admin-table" aria-label="背景条目">' +
                '<thead>' +
                  '<tr>' +
                    '<th class="hero-bg-admin-col-idx">#</th>' +
                    '<th class="hero-bg-admin-col-mobile">手机用图</th>' +
                    '<th class="hero-bg-admin-col-desktop">电脑用图/视频</th>' +
                    '<th class="hero-bg-admin-col-ops">操作</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody id="heroBgAdminList"></tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<input type="file" id="heroBgSlotFileInput" accept="video/mp4,video/webm,video/quicktime,image/*,.heic,.heif" hidden />' +
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
  var addBtn = document.getElementById("heroBgAddBtn");
  var slotFileInput = document.getElementById("heroBgSlotFileInput");
  var bodyOverflowPrev = "";
  var pendingSlot = null;
  var focusedSlot = null;

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

  function isImageFile(file) {
    if (!file) return false;
    var t = String(file.type || "").toLowerCase();
    if (t.indexOf("image/") === 0) return true;
    return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
  }

  function isHeicFile(file) {
    if (!file) return false;
    var t = String(file.type || "").toLowerCase();
    if (t === "image/heic" || t === "image/heif") return true;
    return /\.(heic|heif)$/i.test(file.name || "");
  }

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf("video/") === 0) return true;
    return /\.(mp4|webm|mov|m4v)$/i.test(file.name || "");
  }

  function loadHeic2Any() {
    return new Promise(function (resolve, reject) {
      if (typeof window.heic2any === "function") {
        resolve(window.heic2any);
        return;
      }
      var existing = document.querySelector("script[data-heic2any]");
      if (existing) {
        existing.addEventListener("load", function () {
          if (typeof window.heic2any === "function") resolve(window.heic2any);
          else reject(new Error("heic2any 加载失败"));
        });
        existing.addEventListener("error", function () {
          reject(new Error("heic2any 脚本加载失败"));
        });
        return;
      }
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
      s.async = true;
      s.setAttribute("data-heic2any", "1");
      s.onload = function () {
        if (typeof window.heic2any === "function") resolve(window.heic2any);
        else reject(new Error("heic2any 不可用"));
      };
      s.onerror = function () {
        reject(new Error("heic2any 脚本加载失败"));
      };
      document.head.appendChild(s);
    });
  }

  function blobToJpegFile(blob, baseName) {
    var name = String(baseName || "image").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  }

  function drawToJpegFiles(source, baseName) {
    return new Promise(function (resolve, reject) {
      var w = source.naturalWidth || source.videoWidth || source.width || 0;
      var h = source.naturalHeight || source.videoHeight || source.height || 0;
      if (!w || !h) {
        reject(new Error("无法读取图片尺寸"));
        return;
      }
      function make(maxEdge, quality, suffix) {
        var scale = Math.min(1, maxEdge / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(source, 0, 0, cw, ch);
        return new Promise(function (res, rej) {
          canvas.toBlob(
            function (blob) {
              if (!blob) {
                rej(new Error("JPEG 编码失败"));
                return;
              }
              res(blobToJpegFile(blob, baseName + suffix));
            },
            "image/jpeg",
            quality
          );
        });
      }
      Promise.all([make(2560, 0.88, ""), make(480, 0.8, "-thumb")])
        .then(function (pair) {
          resolve({ full: pair[0], thumb: pair[1] });
        })
        .catch(reject);
    });
  }

  function decodeImageToElement(fileOrBlob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(fileOrBlob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("浏览器无法解码该图片"));
      };
      img.src = url;
    });
  }

  /** 任意图（含 HEIC）→ JPEG 原图 + JPEG 缩略图 */
  function normalizeImagePair(file) {
    var base = String(file.name || "image").replace(/\.[^.]+$/, "") || "image";
    var chain = Promise.resolve(file);
    if (isHeicFile(file)) {
      setStatus("正在将 HEIC 转为 JPEG…");
      chain = loadHeic2Any().then(function (heic2any) {
        return heic2any({
          blob: file,
          toType: "image/jpeg",
          quality: 0.92,
        }).then(function (result) {
          var blob = Array.isArray(result) ? result[0] : result;
          return blobToJpegFile(blob, base);
        });
      });
    }
    return chain.then(function (jpegish) {
      setStatus("正在生成缩略图…");
      return decodeImageToElement(jpegish).then(function (img) {
        return drawToJpegFiles(img, base);
      });
    });
  }

  /**
   * @returns {Promise<{ file: File, poster: File|null, media_type: string }>}
   */
  function prepareUploadBundle(file) {
    if (!file) return Promise.reject(new Error("无文件"));
    if (isImageFile(file) || isHeicFile(file)) {
      return normalizeImagePair(file).then(function (pair) {
        return { file: pair.full, poster: pair.thumb, media_type: "image" };
      });
    }
    if (isVideoFile(file)) {
      return ensureMp4File(file).then(function (ready) {
        setStatus("正在生成视频缩略图…");
        return captureVideoPoster(ready)
          .then(function (poster) {
            return { file: ready, poster: poster, media_type: "video" };
          })
          .catch(function () {
            setStatus("视频缩略图生成失败，将无封面上传", "error");
            return { file: ready, poster: null, media_type: "video" };
          });
      });
    }
    return Promise.reject(new Error("请选择图片或视频文件"));
  }

  function tryPlayMediaEl(video) {
    if (!video) return Promise.resolve(false);
    video.muted = true;
    video.defaultMuted = true;
    var p = video.play();
    if (!p || typeof p.then !== "function") return Promise.resolve(true);
    return p.then(function () { return true; }).catch(function () { return false; });
  }

  /** 从视频抽一帧做成 JPEG 缩略图（多点尝试，避免黑帧） */
  function captureVideoPoster(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error("无视频"));
        return;
      }
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;

      var done = false;
      function cleanup() {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      }
      function fail(err) {
        if (done) return;
        done = true;
        cleanup();
        reject(err || new Error("抽帧失败"));
      }
      function ok(posterFile) {
        if (done) return;
        done = true;
        cleanup();
        resolve(posterFile);
      }

      var timer = setTimeout(function () {
        fail(new Error("抽帧超时"));
      }, 30000);

      video.onerror = function () {
        clearTimeout(timer);
        fail(new Error("无法解码视频"));
      };

      function frameLooksBlack(ctx, w, h) {
        try {
          var sample = ctx.getImageData(0, 0, Math.min(w, 32), Math.min(h, 32)).data;
          var dark = 0;
          var n = sample.length / 4;
          for (var i = 0; i < sample.length; i += 4) {
            if (sample[i] + sample[i + 1] + sample[i + 2] < 30) dark++;
          }
          return dark / n > 0.92;
        } catch (e) {
          return false;
        }
      }

      function grabAt(seekTo) {
        return new Promise(function (resGrab) {
          var onSeeked = function () {
            video.removeEventListener("seeked", onSeeked);
            try {
              var w = video.videoWidth || 0;
              var h = video.videoHeight || 0;
              if (!w || !h) {
                resGrab(null);
                return;
              }
              var maxEdge = 640;
              var scale = Math.min(1, maxEdge / Math.max(w, h));
              var cw = Math.max(1, Math.round(w * scale));
              var ch = Math.max(1, Math.round(h * scale));
              var canvas = document.createElement("canvas");
              canvas.width = cw;
              canvas.height = ch;
              var ctx = canvas.getContext("2d");
              ctx.drawImage(video, 0, 0, cw, ch);
              if (frameLooksBlack(ctx, cw, ch)) {
                resGrab(null);
                return;
              }
              canvas.toBlob(
                function (blob) {
                  if (!blob) {
                    resGrab(null);
                    return;
                  }
                  var base = String(file.name || "video").replace(/\.[^.]+$/, "") || "video";
                  resGrab(blobToJpegFile(blob, base + "-poster"));
                },
                "image/jpeg",
                0.85
              );
            } catch (eGrab) {
              resGrab(null);
            }
          };
          video.addEventListener("seeked", onSeeked);
          try {
            video.currentTime = seekTo;
          } catch (eSeek) {
            video.removeEventListener("seeked", onSeeked);
            resGrab(null);
          }
        });
      }

      function seekPoints(dur) {
        var pts = [0.25, 0.8, 1.5, 3];
        if (isFinite(dur) && dur > 0) {
          pts = [Math.min(0.3, dur * 0.05), dur * 0.12, dur * 0.25, dur * 0.4]
            .map(function (t) {
              return Math.min(Math.max(t, 0.05), Math.max(dur - 0.05, 0.05));
            });
        }
        // unique
        var seen = {};
        return pts.filter(function (t) {
          var k = t.toFixed(2);
          if (seen[k]) return false;
          seen[k] = 1;
          return true;
        });
      }

      video.onloadedmetadata = function () {
        var dur = Number(video.duration);
        var pts = seekPoints(dur);
        var i = 0;
        function next() {
          if (i >= pts.length) {
            // 最后一试：接受可能偏暗的帧
            grabAt(pts[0] || 0.2).then(function (fileOut) {
              clearTimeout(timer);
              if (fileOut) ok(fileOut);
              else fail(new Error("抽帧失败"));
            });
            return;
          }
          grabAt(pts[i++]).then(function (fileOut) {
            if (fileOut) {
              clearTimeout(timer);
              ok(fileOut);
            } else next();
          });
        }
        // 先尝试轻量播放，帮助部分编码吐出关键
        tryPlayMediaEl(video).then(function () {
          setTimeout(function () {
            video.pause();
            next();
          }, 120);
        });
      };
    });
  }

  /** 从已上传视频 URL 抽封面（用于管理端补缩略图） */
  function capturePosterFromMediaUrl(mediaUrl, baseName) {
    return new Promise(function (resolve, reject) {
      if (!mediaUrl) {
        reject(new Error("无视频地址"));
        return;
      }
      var video = document.createElement("video");
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = mediaUrl;
      var timer = setTimeout(function () {
        reject(new Error("抽帧超时"));
      }, 25000);
      video.onerror = function () {
        clearTimeout(timer);
        reject(new Error("无法加载视频"));
      };
      video.onloadedmetadata = function () {
        var dur = Number(video.duration);
        var seekTo = 0.4;
        if (isFinite(dur) && dur > 0) {
          seekTo = Math.min(Math.max(dur * 0.12, 0.2), Math.max(dur - 0.1, 0.2));
        }
        var onSeeked = function () {
          video.removeEventListener("seeked", onSeeked);
          try {
            var w = video.videoWidth;
            var h = video.videoHeight;
            if (!w || !h) {
              clearTimeout(timer);
              reject(new Error("尺寸无效"));
              return;
            }
            var canvas = document.createElement("canvas");
            var scale = Math.min(1, 640 / Math.max(w, h));
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              function (blob) {
                clearTimeout(timer);
                if (!blob) {
                  reject(new Error("编码失败"));
                  return;
                }
                resolve(blobToJpegFile(blob, (baseName || "video") + "-poster"));
              },
              "image/jpeg",
              0.85
            );
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        };
        video.addEventListener("seeked", onSeeked);
        tryPlayMediaEl(video).then(function () {
          video.pause();
          try {
            video.currentTime = seekTo;
          } catch (e2) {
            onSeeked();
          }
        });
      };
    });
  }

  function pickRecorderMime() {
    var cands = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
      return "";
    }
    for (var i = 0; i < cands.length; i++) {
      if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return "";
  }

  /**
   * 不再用 MediaRecorder 转码：容易得到“只有一帧/几乎不动”的坏文件。
   * 原样上传 mp4/webm/mov，由浏览器直接播放。
   */
  function ensureMp4File(file) {
    return Promise.resolve(file);
  }

  function isPlaceholderRef(value) {
    if (!value) return false;
    return String(value).indexOf("empty-placeholder") >= 0;
  }

  function slotHasMedia(item, slot) {
    if (!item) return false;
    if (slot === "mobile") {
      if (isPlaceholderRef(item.r2_key_mobile) || isPlaceholderRef(item.poster_r2_key_mobile)) {
        return false;
      }
      if (!item.r2_key_mobile && !item.media_url_mobile && !item.poster_url_mobile) {
        return false;
      }
      // 新增空行只写了桌面占位，手机槽本身无资源
      if (!item.r2_key_mobile && !item.media_url_mobile) return false;
      return !!(item.media_url_mobile || item.poster_url_mobile || item.r2_key_mobile);
    }
    if (isPlaceholderRef(item.r2_key) || isPlaceholderRef(item.poster_r2_key)) {
      return false;
    }
    return !!(item.media_url || item.poster_url || item.r2_key);
  }

  function confirmOverwriteIfNeeded(item, slot) {
    if (!slotHasMedia(item, slot)) return true;
    return window.confirm("是否覆盖原图？\n\n确定 = 覆盖，取消 = 不覆盖");
  }

  function mediaUrlFromKey(r2Key) {
    var key = String(r2Key || "").trim().replace(/^\/+/, "");
    if (!key) return "";
    if (key.indexOf("hero/") !== 0) key = "hero/" + key;
    return "/api/hero-media?key=" + encodeURIComponent(key);
  }

  function renderThumb(mediaEl, opts, badge, emptyHint) {
    mediaEl.innerHTML = "";
    mediaEl.classList.remove("has-media");
    var url = opts && (opts.media_url || "");
    var poster = opts && (opts.poster_url || "");
    var type = opts && opts.media_type === "image" ? "image" : "video";
    if (isPlaceholderRef(url) || isPlaceholderRef(poster)) {
      url = "";
      poster = "";
    }
    if (!url && opts && opts.r2_key) url = mediaUrlFromKey(opts.r2_key);
    if (!poster && opts && opts.poster_r2_key) poster = mediaUrlFromKey(opts.poster_r2_key);
    if (!url && !poster) {
      var plus = document.createElement("span");
      plus.className = "hero-bg-admin-thumb-empty";
      plus.textContent = "+";
      mediaEl.appendChild(plus);
      var hint = document.createElement("span");
      hint.className = "hero-bg-admin-thumb-hint";
      hint.textContent = emptyHint || "拖入\n或 Ctrl+V";
      mediaEl.appendChild(hint);
      return;
    }
    mediaEl.classList.add("has-media");
    // 视频在管理端优先显示封面图，避免无 poster / 未解码时整格发黑
    if (type === "video") {
      var cover = poster || "";
      if (cover) {
        var coverImg = document.createElement("img");
        coverImg.alt = "";
        coverImg.src = cover;
        coverImg.addEventListener("error", function () {
          if (url) hydrateMissingVideoPoster(mediaEl, url, opts, badge);
        });
        mediaEl.appendChild(coverImg);
      } else if (url) {
        hydrateMissingVideoPoster(mediaEl, url, opts, badge);
      }
      if (badge) appendBadge(mediaEl, badge);
      return;
    }
    var img = document.createElement("img");
    img.alt = "";
    var primary = url || poster;
    var fallback = url && poster && poster !== url ? poster : "";
    if (!url && poster) {
      primary = poster;
      fallback = "";
    }
    img.src = primary;
    if (fallback) {
      img.addEventListener("error", function onErr() {
        img.removeEventListener("error", onErr);
        if (img.src !== fallback) img.src = fallback;
      });
    }
    mediaEl.appendChild(img);
    if (badge) appendBadge(mediaEl, badge);
  }

  function appendBadge(mediaEl, badge) {
    var b = document.createElement("span");
    b.className = "hero-bg-admin-thumb-badge";
    b.textContent = badge;
    mediaEl.appendChild(b);
  }

  function makeAdminVideoEl(url, poster) {
    var video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (poster) video.poster = poster;
    video.addEventListener("loadeddata", function () {
      try {
        if (video.currentTime < 0.05) video.currentTime = 0.12;
      } catch (e) {}
    });
    return video;
  }

  function hydrateMissingVideoPoster(mediaEl, url, opts, badge) {
    mediaEl.appendChild(makeAdminVideoEl(url, ""));
    var hint = document.createElement("span");
    hint.className = "hero-bg-admin-thumb-hint";
    hint.textContent = "生成封面中…";
    mediaEl.appendChild(hint);

    capturePosterFromMediaUrl(url, "hero-poster")
      .then(function (posterFile) {
        var localUrl = URL.createObjectURL(posterFile);
        mediaEl.innerHTML = "";
        var img = document.createElement("img");
        img.alt = "";
        img.src = localUrl;
        mediaEl.appendChild(img);
        if (badge) appendBadge(mediaEl, badge);
        if (opts && opts.itemId) {
          return uploadPosterOnly(opts.itemId, opts.slot || "desktop", posterFile);
        }
      })
      .catch(function () {
        hint.textContent = "无封面\n可重传视频";
      });
  }

  function uploadPosterOnly(itemId, slot, posterFile) {
    var phone = getLoggedInPhone();
    if (!phone || !itemId || !posterFile) return Promise.resolve();
    var form = new FormData();
    form.append("phone", phone);
    form.append("id", String(itemId));
    form.append("slot", slot || "desktop");
    form.append("poster_only", "1");
    form.append("media_type", "video");
    // 占位 file，服务端 poster_only 路径不使用它，但 multipart 校验要有 file 字段
    form.append("file", posterFile, "poster-placeholder.jpg");
    form.append("poster", posterFile);
    return apiJson("POST", "/api/hero-backgrounds-admin", form).then(function () {
      setStatus("已补全视频封面", "ok");
    });
  }

  function pickMobilePreview(item) {
    if (!slotHasMedia(item, "mobile")) {
      return { media_type: "image", media_url: "", poster_url: "" };
    }
    return {
      media_type: "image",
      media_url: item.media_url_mobile || mediaUrlFromKey(item.r2_key_mobile),
      poster_url: item.poster_url_mobile || mediaUrlFromKey(item.poster_r2_key_mobile),
      r2_key: item.r2_key_mobile || "",
      poster_r2_key: item.poster_r2_key_mobile || "",
    };
  }

  function pickDesktopPreview(item) {
    if (!slotHasMedia(item, "desktop")) {
      return { media_type: "image", media_url: "", poster_url: "" };
    }
    return {
      media_type: item.media_type,
      media_url: item.media_url || mediaUrlFromKey(item.r2_key),
      poster_url: item.poster_url || mediaUrlFromKey(item.poster_r2_key),
      r2_key: item.r2_key || "",
      poster_r2_key: item.poster_r2_key || "",
      itemId: item.id,
      slot: "desktop",
    };
  }

  function clearActiveSlots() {
    if (!listEl) return;
    var nodes = listEl.querySelectorAll(".hero-bg-admin-thumb.is-active-slot");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove("is-active-slot");
    }
  }

  function activateSlot(thumbEl, item, slot) {
    clearActiveSlots();
    focusedSlot = { item: item, slot: slot, el: thumbEl };
    thumbEl.classList.add("is-active-slot");
    try {
      thumbEl.focus({ preventScroll: true });
    } catch (e) {
      thumbEl.focus();
    }
    setStatus(
      "已选中" +
        (slot === "mobile" ? "手机" : "电脑") +
        "区域 — 可 Ctrl+V 粘贴，或拖入文件（双击也可选文件）",
      "ok"
    );
  }

  function openSlotFilePicker(item, slot) {
    pendingSlot = { item: item, slot: slot };
    if (!slotFileInput) return;
    slotFileInput.value = "";
    slotFileInput.accept =
      slot === "mobile"
        ? "image/*,.heic,.heif"
        : "video/mp4,video/webm,video/quicktime,image/*,.heic,.heif";
    slotFileInput.click();
  }

  function replaceSlotMedia(item, slot, file) {
    var phone = getLoggedInPhone();
    if (!phone) {
      setStatus("请先登录运维账号。", "error");
      return Promise.resolve();
    }
    if (slot === "mobile" && isVideoFile(file)) {
      setStatus("手机端请使用图片（不支持视频）", "error");
      return Promise.resolve();
    }
    if (!confirmOverwriteIfNeeded(item, slot)) {
      setStatus("已取消覆盖", "ok");
      return Promise.resolve();
    }
    setStatus("处理文件…");
    return prepareUploadBundle(file)
      .then(function (bundle) {
        if (slot === "mobile" && bundle.media_type === "video") {
          throw new Error("手机端请使用图片（不支持视频）");
        }
        var form = new FormData();
        form.append("phone", phone);
        form.append("id", String(item.id));
        form.append("slot", slot);
        form.append("file", bundle.file);
        form.append("media_type", bundle.media_type);
        if (bundle.poster) form.append("poster", bundle.poster);
        setStatus("上传中…");
        return apiJson("POST", "/api/hero-backgrounds-admin", form);
      })
      .then(function () {
        setStatus("已更新" + (slot === "mobile" ? "手机" : "电脑") + "端媒体", "ok");
        return loadAdminData();
      })
      .then(function () {
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function bindThumbSlot(thumbEl, item, slot) {
    thumbEl.tabIndex = 0;
    thumbEl.setAttribute("role", "button");
    thumbEl.setAttribute(
      "aria-label",
      (slot === "mobile" ? "手机" : "电脑") +
        "端媒体：单击激活后 Ctrl+V 粘贴，或拖入文件，双击选文件"
    );

    thumbEl.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      activateSlot(thumbEl, item, slot);
    });

    thumbEl.addEventListener("dblclick", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      activateSlot(thumbEl, item, slot);
      openSlotFilePicker(item, slot);
    });

    thumbEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activateSlot(thumbEl, item, slot);
        openSlotFilePicker(item, slot);
      }
    });

    thumbEl.addEventListener("focus", function () {
      if (focusedSlot && focusedSlot.el === thumbEl) return;
      activateSlot(thumbEl, item, slot);
    });

    ["dragenter", "dragover"].forEach(function (evtName) {
      thumbEl.addEventListener(evtName, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        thumbEl.classList.add("is-drop-target");
      });
    });
    thumbEl.addEventListener("dragleave", function (ev) {
      ev.preventDefault();
      thumbEl.classList.remove("is-drop-target");
    });
    thumbEl.addEventListener("drop", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      thumbEl.classList.remove("is-drop-target");
      var files = ev.dataTransfer && ev.dataTransfer.files;
      var file = files && files[0];
      if (!file) return;
      activateSlot(thumbEl, item, slot);
      replaceSlotMedia(item, slot, file);
    });
  }

  function fileFromClipboard(ev) {
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      if (it.kind === "file" && (it.type.indexOf("image/") === 0 || it.type.indexOf("video/") === 0)) {
        var raw = it.getAsFile();
        if (!raw) continue;
        if (raw.name && String(raw.name).trim()) return raw;
        var subtype = String(it.type || "image/png").split("/")[1] || "png";
        if (subtype.indexOf("jpeg") >= 0) subtype = "jpg";
        return new File([raw], "paste." + subtype, {
          type: raw.type || it.type || "image/png",
        });
      }
    }
    return null;
  }

  function isEmptyBackgroundRow(item) {
    return !slotHasMedia(item, "mobile") && !slotHasMedia(item, "desktop");
  }

  function listHasEmptyRow(items) {
    if (!items || !items.length) return false;
    for (var i = 0; i < items.length; i++) {
      if (isEmptyBackgroundRow(items[i])) return true;
    }
    return false;
  }

  function syncAddButtonState(items) {
    if (!addBtn) return;
    var blocked = listHasEmptyRow(items);
    addBtn.disabled = blocked;
    addBtn.title = blocked ? "已有空行，请先拖入图片后再新增" : "新增空行";
  }

  function renderList(items) {
    if (!listEl) return;
    listEl.innerHTML = "";
    syncAddButtonState(items);
    if (!items || !items.length) {
      var emptyTr = document.createElement("tr");
      var emptyTd = document.createElement("td");
      emptyTd.colSpan = 4;
      emptyTd.className = "hero-bg-admin-empty";
      emptyTd.textContent =
        "暂无背景。点击「新增」后，在黑色区域拖入图片，或单击激活后 Ctrl+V 粘贴。";
      emptyTr.appendChild(emptyTd);
      listEl.appendChild(emptyTr);
      return;
    }

    items.forEach(function (item, index) {
      var tr = document.createElement("tr");
      if (!item.is_active) tr.className = "is-inactive";

      var tdIdx = document.createElement("td");
      tdIdx.className = "hero-bg-admin-col-idx";
      tdIdx.textContent = String(index + 1);

      var tdMobile = document.createElement("td");
      tdMobile.className = "hero-bg-admin-col-mobile";
      var mobileThumb = document.createElement("div");
      mobileThumb.className = "hero-bg-admin-thumb hero-bg-admin-thumb--mobile";
      renderThumb(mobileThumb, pickMobilePreview(item), "图", "拖入图片\n或 Ctrl+V");
      bindThumbSlot(mobileThumb, item, "mobile");
      tdMobile.appendChild(mobileThumb);

      var tdDesktop = document.createElement("td");
      tdDesktop.className = "hero-bg-admin-col-desktop";
      var deskThumb = document.createElement("div");
      deskThumb.className = "hero-bg-admin-thumb hero-bg-admin-thumb--desktop";
      renderThumb(
        deskThumb,
        pickDesktopPreview(item),
        item.media_type === "video" ? "视频" : "图",
        "拖入图/视频\n或 Ctrl+V"
      );
      if (item.title) {
        deskThumb.title = String(item.title) + (item.subtitle ? " · " + item.subtitle : "");
      }
      bindThumbSlot(deskThumb, item, "desktop");
      tdDesktop.appendChild(deskThumb);

      var tdOps = document.createElement("td");
      tdOps.className = "hero-bg-admin-col-ops";
      var ops = document.createElement("div");
      ops.className = "hero-bg-admin-ops";

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "hero-bg-admin-icon-btn hero-bg-admin-icon-btn--danger";
      delBtn.setAttribute("aria-label", "删除背景 #" + (index + 1));
      delBtn.title = "删除";
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="3 6 5 6 21 6"></polyline>' +
        '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
        '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
        '<line x1="10" y1="11" x2="10" y2="17"></line>' +
        '<line x1="14" y1="11" x2="14" y2="17"></line>' +
        "</svg>";
      delBtn.addEventListener("click", function () {
        if (!window.confirm("确定删除该背景？此操作不可恢复。")) return;
        deleteItem(item.id);
      });

      var switchLabel = document.createElement("label");
      switchLabel.className = "hero-bg-admin-switch";
      switchLabel.title = item.is_active ? "已启用，点击停止" : "已停止，点击启用";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!item.is_active;
      cb.setAttribute("aria-label", "启用背景 #" + (index + 1));
      cb.addEventListener("change", function () {
        switchLabel.title = cb.checked ? "已启用，点击停止" : "已停止，点击启用";
        patchItem(item.id, { is_active: !!cb.checked });
      });
      var switchUi = document.createElement("span");
      switchUi.className = "hero-bg-admin-switch-ui";
      switchUi.setAttribute("aria-hidden", "true");
      switchLabel.appendChild(cb);
      switchLabel.appendChild(switchUi);

      ops.appendChild(switchLabel);
      ops.appendChild(delBtn);
      tdOps.appendChild(ops);

      tr.appendChild(tdIdx);
      tr.appendChild(tdMobile);
      tr.appendChild(tdDesktop);
      tr.appendChild(tdOps);
      listEl.appendChild(tr);
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
        setStatus("共 " + (data.items || []).length + " 条", "ok");
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
        setStatus("轮换设置已保存", "ok");
        if (typeof window.reloadHeroBackground === "function") window.reloadHeroBackground();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
      });
  }

  function createEmptyRow() {
    var phone = getLoggedInPhone();
    if (!phone) {
      setStatus("请先登录运维账号。", "error");
      return;
    }
    if (addBtn && addBtn.disabled) {
      setStatus("已有空行，请先拖入图片后再新增", "error");
      return;
    }
    setStatus("检查中…");
    apiJson("GET", adminUrl())
      .then(function (data) {
        var items = (data && data.items) || [];
        if (listHasEmptyRow(items)) {
          syncAddButtonState(items);
          renderList(items);
          applyConfig(data.config);
          setStatus("已有空行，请先拖入图片后再新增", "error");
          return null;
        }
        setStatus("新增中…");
        return apiJson("POST", "/api/hero-backgrounds-admin", {
          phone: phone,
          action: "create_empty",
        });
      })
      .then(function (created) {
        if (!created) return;
        setStatus("已新增空行：单击黑块激活后 Ctrl+V，或直接拖入", "ok");
        return loadAdminData();
      })
      .catch(function (err) {
        setStatus(err.message || String(err), "error");
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
    focusedSlot = null;
    pendingSlot = null;
  }

  if (closeBtn) closeBtn.addEventListener("click", closeHeroBgAdminModal);
  if (overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeHeroBgAdminModal();
    });
  }
  if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveConfig);
  if (addBtn) addBtn.addEventListener("click", createEmptyRow);

  if (slotFileInput) {
    slotFileInput.addEventListener("change", function () {
      var file = slotFileInput.files && slotFileInput.files[0];
      var target = pendingSlot;
      pendingSlot = null;
      if (!file || !target) return;
      replaceSlotMedia(target.item, target.slot, file);
    });
  }

  document.addEventListener("paste", function (ev) {
    if (!overlay || !overlay.classList.contains("show")) return;
    var file = fileFromClipboard(ev);
    if (!file) return;
    var target = focusedSlot;
    if (!target || !target.el || !target.el.isConnected) {
      setStatus("请先单击要粘贴的黑色区域（手机或电脑）", "error");
      return;
    }
    ev.preventDefault();
    activateSlot(target.el, target.item, target.slot);
    replaceSlotMedia(target.item, target.slot, file);
  });

  var menuBtn = document.getElementById("topNavHeroBackground");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      openHeroBgAdminModal();
    });
  }

  window.openHeroBgAdminModal = openHeroBgAdminModal;
  window.closeHeroBgAdminModal = closeHeroBgAdminModal;
})();
