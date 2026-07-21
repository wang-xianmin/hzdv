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
  };

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeItemsFromApi(payload) {
    if (!payload || !payload.success || !Array.isArray(payload.items)) return [];
    return payload.items.filter(function (item) {
      return item && (item.media_url || item.r2_key);
    });
  }

  function isMobileViewport() {
    return window.innerWidth <= 768;
  }

  function pickMediaUrl(item) {
    if (!item) return "";
    if (isMobileViewport() && item.media_url_mobile) return String(item.media_url_mobile);
    if (item.media_url) return String(item.media_url);
    return "";
  }

  function pickPosterUrl(item) {
    if (!item) return "";
    if (isMobileViewport() && item.poster_url_mobile) return String(item.poster_url_mobile);
    if (item.poster_url) return String(item.poster_url);
    return "";
  }

  function buildLayerEl(kind, className) {
    var wrap = document.createElement("div");
    wrap.className = "site-hero__layer " + className;
    if (kind === "video") {
      var video = document.createElement("video");
      video.className = "site-hero__video";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.preload = "auto";
      wrap.appendChild(video);
    } else {
      var img = document.createElement("img");
      img.className = "site-hero__image";
      img.alt = "";
      wrap.appendChild(img);
    }
    return wrap;
  }

  function getLayerMediaEl(layer) {
    if (!layer) return null;
    return layer.querySelector("video, img");
  }

  function tryPlayVideo(video) {
    if (!video) return Promise.resolve(false);
    video.muted = true;
    return video
      .play()
      .then(function () {
        return true;
      })
      .catch(function () {
        return false;
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

      var idx = 0;
      function tryNext() {
        if (idx >= sources.length) {
          resolve(false);
          return;
        }
        var src = sources[idx++];
        video.pause();
        video.removeAttribute("src");
        while (video.firstChild) video.removeChild(video.firstChild);
        video.src = src;
        if (item.poster_url) video.poster = pickPosterUrl(item);

        var settled = false;
        function done(ok) {
          if (settled) return;
          settled = true;
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("error", onError);
          if (ok) resolve(true);
          else tryNext();
        }
        function onLoaded() {
          tryPlayVideo(video).then(function (played) {
            done(played);
          });
        }
        function onError() {
          done(false);
        }
        video.addEventListener("loadeddata", onLoaded);
        video.addEventListener("error", onError);
        video.load();
      }
      tryNext();
    });
  }

  function loadImage(img, item) {
    return new Promise(function (resolve) {
      var url = pickMediaUrl(item);
      if (!img || !url) {
        resolve(false);
        return;
      }
      img.onload = function () {
        resolve(true);
      };
      img.onerror = function () {
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
    var inactiveMedia = getLayerMediaEl(inactiveLayer);
    var isVideo = item.media_type === "video";

    document.documentElement.style.setProperty(
      "--hero-transition",
      String(state.config.transition_ms || 800) + "ms"
    );

    var loadPromise;
    if (isVideo) {
      loadPromise = loadVideoSources(inactiveMedia, item);
    } else {
      loadPromise = loadImage(inactiveMedia, item);
    }

    loadPromise.then(function (ok) {
      if (!ok) return;
      setActiveLayer(inactiveLayerIndex);
      state.index = nextIndex;
      renderHeroCopy(item);
      updateDots();

      var oldLayer = state.layers[state.activeLayer === 0 ? 1 : 0];
      var oldVideo = oldLayer && oldLayer.querySelector("video");
      if (oldVideo) {
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
    state.layers = [buildLayerEl("video", "site-hero__layer--a"), buildLayerEl("video", "site-hero__layer--b")];
    state.layers.forEach(function (layer) {
      mediaRoot.appendChild(layer);
    });
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
        return items;
      })
      .catch(function () {
        return [];
      });
  }

  function boot(items) {
    state.items = items.length ? items : LOCAL_FALLBACK_ITEMS.slice();
    state.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    initLayers();
    renderDots();
    showItem(0, true);
    scheduleNext();
  }

  function reloadHeroBackground() {
    if (state.timer) clearTimeout(state.timer);
    fetchHeroItems().then(boot);
  }

  window.reloadHeroBackground = reloadHeroBackground;

  function init() {
    var hero = $("site-hero");
    if (!hero) return;
    fetchHeroItems().then(boot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
