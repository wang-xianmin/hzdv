(function () {
  "use strict";

  /** 本地试验：把 IMG_9741 转成 mp4 后放到 assets/hero/（MOV 在 Chrome 上可能无法播放） */
  var LOCAL_VIDEO_SOURCES = [
    "assets/hero/IMG_9741.mp4",
    "assets/hero/IMG_9741.mov",
    "assets/hero/IMG_9741.MOV",
  ];

  var LOCAL_FALLBACK_ITEMS = [
    {
      id: "local-1",
      media_type: "video",
      media_url: LOCAL_VIDEO_SOURCES[0],
      local_sources: LOCAL_VIDEO_SOURCES.slice(),
      poster_url: "assets/hero/IMG_9741-poster.jpg",
      title: "",
      subtitle: "",
      cta_label: "",
      cta_url: "",
      duration_ms: null,
    },
  ];

  var state = {
    items: [],
    config: {
      rotate_interval_ms: 30000,
      transition_ms: 800,
      playback_mode: "sequential",
    },
    index: 0,
    timer: null,
    layers: [],
    activeLayer: 0,
    reducedMotion: false,
    fromApi: false,
    soundUnlocked: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeItemsFromApi(payload) {
    if (!payload || !payload.success || !Array.isArray(payload.items)) return [];
    return payload.items.filter(function (item) {
      return item && (item.media_url || item.media_url_mobile || item.r2_key || item.r2_key_mobile);
    });
  }

  function isMobileViewport() {
    return window.innerWidth <= 768;
  }

  function pickMediaUrl(item) {
    if (!item) return "";
    if (isMobileViewport()) {
      if (item.media_url_mobile) return String(item.media_url_mobile);
      if (item.poster_url_mobile) return String(item.poster_url_mobile);
    }
    if (item.media_url) return String(item.media_url);
    if (item.media_url_mobile) return String(item.media_url_mobile);
    return "";
  }

  function pickPosterUrl(item) {
    if (!item) return "";
    if (isMobileViewport() && item.poster_url_mobile) return String(item.poster_url_mobile);
    if (item.poster_url) return String(item.poster_url);
    if (item.poster_url_mobile) return String(item.poster_url_mobile);
    return "";
  }

  /** 手机视口且有手机图时按图片播；否则跟条目 media_type */
  function itemDisplayKind(item) {
    if (!item) return "image";
    if (isMobileViewport() && (item.media_url_mobile || item.poster_url_mobile)) {
      return "image";
    }
    return item.media_type === "image" ? "image" : "video";
  }

  function buildEmptyLayer(className) {
    var wrap = document.createElement("div");
    wrap.className = "site-hero__layer " + className;
    return wrap;
  }

  function ensureLayerMedia(layer, kind) {
    if (!layer) return null;
    var wantTag = kind === "image" ? "IMG" : "VIDEO";
    var current = layer.querySelector("video, img");
    if (current && current.tagName === wantTag) return current;
    layer.innerHTML = "";
    if (kind === "image") {
      var img = document.createElement("img");
      img.className = "site-hero__image";
      img.alt = "";
      layer.appendChild(img);
      return img;
    }
    var video = document.createElement("video");
    video.className = "site-hero__video";
    video.muted = true;
    // 不循环：短于轮换间隔时定格最后一帧，避免黑屏
    video.loop = false;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    layer.appendChild(video);
    return video;
  }

  function getLayerMediaEl(layer) {
    if (!layer) return null;
    return layer.querySelector("video, img");
  }

  function freezeVideoOnLastFrame(video) {
    if (!video) return;
    video.dataset.frozenEnd = "1";
    try {
      var dur = Number(video.duration);
      if (isFinite(dur) && dur > 0.08) {
        video.currentTime = Math.max(0, dur - 0.05);
      }
    } catch (eSeek) {}
    try {
      video.pause();
    } catch (ePause) {}
  }

  function clearVideoFreeze(video) {
    if (!video) return;
    video.dataset.frozenEnd = "";
  }

  function applyHeroSoundState(video) {
    if (!video) return;
    if (state.soundUnlocked) {
      video.muted = false;
      video.defaultMuted = false;
      try {
        video.volume = 1;
      } catch (eVol) {}
      try {
        video.removeAttribute("muted");
      } catch (eAttr) {}
      return;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
  }

  function unlockHeroSound() {
    if (state.soundUnlocked) return;
    state.soundUnlocked = true;
    state.layers.forEach(function (layer) {
      var media = getLayerMediaEl(layer);
      if (!media || media.tagName !== "VIDEO") return;
      applyHeroSoundState(media);
      if (media.dataset.frozenEnd === "1" || media.ended) return;
      tryPlayVideo(media);
    });
  }

  function bindHeroSoundUnlock() {
    if (state.soundUnlockBound) return;
    state.soundUnlockBound = true;
    var once = { once: true, capture: true, passive: true };
    function onInteract() {
      unlockHeroSound();
    }
    window.addEventListener("pointerdown", onInteract, once);
    window.addEventListener("keydown", onInteract, once);
    window.addEventListener("touchstart", onInteract, once);
  }

  function tryPlayVideo(video) {
    if (!video) return Promise.resolve(false);
    if (video.dataset.frozenEnd === "1") return Promise.resolve(true);
    applyHeroSoundState(video);
    video.loop = false;
    video.playsInline = true;
    try {
      video.playbackRate = 1;
      video.defaultPlaybackRate = 1;
    } catch (eRate) {}
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    if (!state.soundUnlocked) video.setAttribute("muted", "");
    else {
      try {
        video.removeAttribute("muted");
      } catch (eRm) {}
    }
    var p = video.play();
    if (!p || typeof p.then !== "function") return Promise.resolve(true);
    return p
      .then(function () {
        try {
          if (video.playbackRate !== 1) video.playbackRate = 1;
        } catch (e2) {}
        return true;
      })
      .catch(function () {
        // 带声播放失败时退回静音自动播放，等用户点一下再开声
        if (state.soundUnlocked) {
          video.muted = true;
          video.defaultMuted = true;
          video.setAttribute("muted", "");
          return video
            .play()
            .then(function () {
              return true;
            })
            .catch(function () {
              return false;
            });
        }
        return false;
      });
  }

  function bindKeepPlaying(video) {
    if (!video || video.dataset.keepPlayBound === "1") return;
    video.dataset.keepPlayBound = "1";
    var resume = function () {
      var active = state.layers[state.activeLayer];
      if (!active || !active.contains(video)) return;
      // 已播完定格：不要再强拉 play（否则可能黑屏或从头播）
      if (video.dataset.frozenEnd === "1" || video.ended) return;
      if (video.paused) tryPlayVideo(video);
    };
    video.addEventListener("pause", function () {
      setTimeout(resume, 30);
    });
    video.addEventListener("stalled", resume);
    video.addEventListener("suspend", function () {
      setTimeout(resume, 100);
    });
  }

  /** 视频结束（短于轮换间隔）时保持最后一帧 */
  function bindHoldLastFrame(video) {
    if (!video || video.dataset.holdEndBound === "1") return;
    video.dataset.holdEndBound = "1";
    video.loop = false;
    video.addEventListener("ended", function () {
      freezeVideoOnLastFrame(video);
    });
    video.addEventListener("timeupdate", function () {
      if (video.dataset.frozenEnd === "1") return;
      var dur = Number(video.duration);
      if (!isFinite(dur) || dur <= 0.1) return;
      if (video.currentTime >= dur - 0.07) {
        freezeVideoOnLastFrame(video);
      }
    });
  }

  function loadVideoSources(video, item) {
    return new Promise(function (resolve) {
      if (!video) {
        resolve(false);
        return;
      }
      var sources = [];
      if (item.local_sources && item.local_sources.length) {
        sources = item.local_sources.slice();
      } else {
        var url = pickMediaUrl(item);
        if (url) sources = [url];
      }
      if (!sources.length) {
        resolve(false);
        return;
      }

      var poster = pickPosterUrl(item);
      if (poster) video.poster = poster;
      clearVideoFreeze(video);
      video.loop = false;
      bindKeepPlaying(video);
      bindHoldLastFrame(video);

      var idx = 0;
      function tryNext() {
        if (idx >= sources.length) {
          resolve(!!poster);
          return;
        }
        var src = sources[idx++];
        clearVideoFreeze(video);
        video.pause();
        video.removeAttribute("src");
        while (video.firstChild) video.removeChild(video.firstChild);
        video.src = src;
        if (poster) video.poster = poster;

        var settled = false;
        function done(ok) {
          if (settled) return;
          settled = true;
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("canplay", onCanPlay);
          video.removeEventListener("error", onError);
          if (ok) resolve(true);
          else tryNext();
        }
        function onLoaded() {
          tryPlayVideo(video).then(function (played) {
            done(true);
            if (!played) setTimeout(function () {
              tryPlayVideo(video);
            }, 0);
          });
        }
        function onCanPlay() {
          if (video.dataset.frozenEnd === "1") return;
          tryPlayVideo(video);
        }
        function onError() {
          done(false);
        }
        video.addEventListener("loadeddata", onLoaded);
        video.addEventListener("canplay", onCanPlay);
        video.addEventListener("error", onError);
        video.load();
      }
      tryNext();
    });
  }

  function loadImage(img, item) {
    return new Promise(function (resolve) {
      var url = pickMediaUrl(item) || pickPosterUrl(item);
      if (!img || !url) {
        resolve(false);
        return;
      }
      img.onload = function () {
        resolve(true);
      };
      img.onerror = function () {
        var fallback = pickPosterUrl(item);
        if (fallback && img.src.indexOf(fallback) < 0 && fallback !== url) {
          img.onerror = function () {
            resolve(false);
          };
          img.src = fallback;
          return;
        }
        resolve(false);
      };
      img.src = url;
    });
  }

  function renderHeroCopy(item) {
    var titleEl = $("hero-title");
    var subtitleEl = $("hero-subtitle");
    var ctaEl = $("hero-cta");
    if (!titleEl || !subtitleEl || !ctaEl) return;

    var title = item && item.title ? String(item.title) : "";
    var subtitle = item && item.subtitle ? String(item.subtitle) : "";
    titleEl.textContent = title;
    subtitleEl.textContent = subtitle;
    titleEl.hidden = !title;
    subtitleEl.hidden = !subtitle;

    ctaEl.innerHTML = "";
    if (item && item.cta_label && item.cta_url) {
      var a = document.createElement("a");
      a.href = item.cta_url;
      a.textContent = item.cta_label;
      a.className = "is-primary";
      ctaEl.appendChild(a);
    }
    ctaEl.hidden = !ctaEl.children.length;
  }

  function renderDots() {
    var dotsEl = $("hero-dots");
    if (!dotsEl) return;
    dotsEl.innerHTML = "";
    if (state.items.length <= 1) {
      dotsEl.hidden = true;
      return;
    }
    dotsEl.hidden = false;
    state.items.forEach(function (_item, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "site-hero__dot" + (i === state.index ? " is-active" : "");
      btn.setAttribute("aria-label", String(i + 1) + " / " + state.items.length);
      btn.addEventListener("click", function () {
        showItem(i, true);
        scheduleNext();
      });
      dotsEl.appendChild(btn);
    });
  }

  function updateDots() {
    var dotsEl = $("hero-dots");
    if (!dotsEl) return;
    dotsEl.querySelectorAll(".site-hero__dot").forEach(function (btn, i) {
      btn.classList.toggle("is-active", i === state.index);
    });
  }

  function setActiveLayer(nextIndex) {
    state.layers.forEach(function (layer, i) {
      layer.classList.toggle("is-active", i === nextIndex);
    });
    state.activeLayer = nextIndex;
  }

  function showItem(index, force) {
    if (!state.items.length) return;
    var nextIndex = index;
    if (nextIndex < 0) nextIndex = state.items.length - 1;
    if (nextIndex >= state.items.length) nextIndex = 0;
    if (!force && nextIndex === state.index && state.layers[state.activeLayer]) return;

    var item = state.items[nextIndex];
    var inactiveLayerIndex = state.activeLayer === 0 ? 1 : 0;
    var inactiveLayer = state.layers[inactiveLayerIndex];
    var kind = itemDisplayKind(item);
    var inactiveMedia = ensureLayerMedia(inactiveLayer, kind);

    document.documentElement.style.setProperty(
      "--hero-transition",
      String(state.config.transition_ms || 800) + "ms"
    );

    var loadPromise =
      kind === "video" ? loadVideoSources(inactiveMedia, item) : loadImage(inactiveMedia, item);

    loadPromise.then(function (ok) {
      if (!ok) {
        console.warn("[hero-background] failed to show item", nextIndex, item && item.id);
        return;
      }
      setActiveLayer(inactiveLayerIndex);
      state.index = nextIndex;
      renderHeroCopy(item);
      updateDots();

      var activeMedia = getLayerMediaEl(state.layers[state.activeLayer]);
      if (activeMedia && activeMedia.tagName === "VIDEO") {
        bindKeepPlaying(activeMedia);
        tryPlayVideo(activeMedia);
        // 切换可见后再拉一次，避免停在首帧
        setTimeout(function () {
          tryPlayVideo(activeMedia);
        }, 80);
        setTimeout(function () {
          tryPlayVideo(activeMedia);
        }, 400);
      }

      var oldLayer = state.layers[state.activeLayer === 0 ? 1 : 0];
      var oldVideo = oldLayer && oldLayer.querySelector("video");
      if (oldVideo && oldVideo !== activeMedia) {
        oldVideo.pause();
      }
    });
  }

  function nextIndex() {
    if (state.items.length <= 1) return 0;
    if (state.config.playback_mode === "random") {
      if (state.items.length === 2) return state.index === 0 ? 1 : 0;
      var r = state.index;
      while (r === state.index) {
        r = Math.floor(Math.random() * state.items.length);
      }
      return r;
    }
    return (state.index + 1) % state.items.length;
  }

  function itemDurationMs(item) {
    if (item && item.duration_ms > 0) return item.duration_ms;
    return state.config.rotate_interval_ms || 30000;
  }

  function scheduleNext() {
    if (state.timer) clearTimeout(state.timer);
    if (state.items.length <= 1 || state.reducedMotion) return;
    var delay = itemDurationMs(state.items[state.index]);
    state.timer = setTimeout(function () {
      showItem(nextIndex(), true);
      scheduleNext();
    }, delay);
  }

  function initLayers() {
    var mediaRoot = $("hero-media");
    if (!mediaRoot) return;
    mediaRoot.innerHTML = "";
    state.layers = [
      buildEmptyLayer("site-hero__layer--a"),
      buildEmptyLayer("site-hero__layer--b"),
    ];
    state.layers.forEach(function (layer) {
      mediaRoot.appendChild(layer);
    });
    state.activeLayer = 0;
  }

  function fetchHeroItems() {
    return fetch("/api/hero-backgrounds", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("hero api " + res.status);
        return res.json();
      })
      .then(function (payload) {
        var items = normalizeItemsFromApi(payload);
        if (payload && payload.config) {
          state.config = Object.assign(state.config, payload.config);
        }
        state.fromApi = true;
        return items;
      })
      .catch(function (err) {
        console.warn("[hero-background] api failed", err);
        state.fromApi = false;
        return [];
      });
  }

  function boot(items) {
    // 接口成功但列表为空：保持空白，不用本地 demo 盖住「已配置但未启用」的情况
    if (state.fromApi) {
      state.items = items.slice();
    } else {
      state.items = items.length ? items : LOCAL_FALLBACK_ITEMS.slice();
    }
    state.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    initLayers();
    renderDots();
    if (state.items.length) {
      showItem(0, true);
      scheduleNext();
    }
  }

  function reloadHeroBackground() {
    if (state.timer) clearTimeout(state.timer);
    fetchHeroItems().then(boot);
  }

  window.reloadHeroBackground = reloadHeroBackground;

  function init() {
    var hero = $("site-hero");
    if (!hero) return;
    bindHeroSoundUnlock();
    fetchHeroItems().then(boot);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!state.items.length) return;
        showItem(state.index, true);
      }, 200);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
