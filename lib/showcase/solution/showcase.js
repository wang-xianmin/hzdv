/**
 * 主展区 · 方案展示（ATS 式四屏）
 * 路径：lib/showcase/solution/showcase.js
 * 挂载：index.html 中的 #site-content
 */
(function (global) {
  "use strict";

  var root = null;
  var recommendEl = null;
  var detailEl = null;
  var emptyEl = null;
  var scrollEl = null;
  var state = {
    hits: [],
    activeId: null,
    activeItem: null,
  };

  function t(zh, en) {
    if (global.currentLang === "en") return en;
    var htmlLang = String(document.documentElement.lang || "").toLowerCase();
    return htmlLang.indexOf("en") === 0 ? en : zh;
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function apiUrl(params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== "") {
        qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    });
    return "/api/catalog-public" + (qs.length ? "?" + qs.join("&") : "");
  }

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j || {} };
      });
    });
  }

  function setShowcaseVisible(on) {
    document.body.classList.toggle("workspace-has-showcase", !!on);
    var el = document.getElementById("site-content");
    if (!el) return;
    if (on) {
      el.hidden = false;
      el.removeAttribute("hidden");
      el.setAttribute("aria-hidden", "false");
      var hero = document.getElementById("site-hero");
      if (hero) hero.classList.add("is-workspace-hidden");
    }
  }

  function ensureRoot() {
    var el = document.getElementById("site-content");
    if (!el) return null;
    // DOM 被清空或首次挂载时重建
    if (
      root === el &&
      recommendEl &&
      el.querySelector("#ssRecommend") &&
      el.querySelector("#ssScroll")
    ) {
      return root;
    }
    root = el;
    root.classList.add("solution-showcase");
    root.innerHTML =
      '<div class="ss-scroll" id="ssScroll">' +
      '<div class="ss-empty" id="ssEmpty">' +
      esc(
        t(
          "向右侧 AI 助手提问，相关产品与方案将展示于此。",
          "Ask the AI assistant — matching products and solutions appear here."
        )
      ) +
      "</div>" +
      '<div class="ss-recommend" id="ssRecommend" hidden>' +
      '<p class="ss-recommend-title" id="ssRecommendTitle"></p>' +
      '<div class="ss-recommend-strip" id="ssRecommendStrip"></div>' +
      '<div class="ss-recommend-table-wrap" id="ssRecommendTableWrap" hidden>' +
      '<table class="ss-recommend-table" id="ssRecommendTable">' +
      "<thead><tr>" +
      "<th>" +
      esc(t("类型", "Kind")) +
      "</th><th>" +
      esc(t("名称", "Name")) +
      "</th><th>" +
      esc(t("型号", "Model")) +
      "</th><th>" +
      esc(t("简介", "Brief")) +
      "</th></tr></thead>" +
      '<tbody id="ssRecommendTbody"></tbody></table></div>' +
      "</div>" +
      '<div class="ss-detail" id="ssDetail" hidden></div>' +
      "</div>";
    recommendEl = root.querySelector("#ssRecommend");
    detailEl = root.querySelector("#ssDetail");
    emptyEl = root.querySelector("#ssEmpty");
    scrollEl = root.querySelector("#ssScroll");
    return root;
  }

  function renderList(items) {
    if (!items || !items.length) return "<ul></ul>";
    return (
      "<ul>" +
      items
        .map(function (line) {
          return "<li>" + esc(line) + "</li>";
        })
        .join("") +
      "</ul>"
    );
  }

  function mediaTag(url, alt) {
    if (!url) return "";
    return (
      '<img src="' +
      esc(url) +
      '" alt="' +
      esc(alt || "") +
      '" loading="lazy" />'
    );
  }

  /** @param {{url?:string, media_type?:string}|null} m */
  function mediaEmbed(m, alt) {
    if (!m || !m.url) return "";
    if (m.media_type === "video") {
      return (
        '<video src="' +
        esc(m.url) +
        '" controls playsinline preload="metadata"></video>'
      );
    }
    return mediaTag(m.url, alt);
  }

  /** 媒体槽：第 2 条（方案斜切 / 产品详情）；缺省回退 summary_image */
  function pickDetailHero(item) {
    if (item.detail_hero && item.detail_hero.url) return item.detail_hero;
    var media = item.media || [];
    if (media[1] && media[1].url) return media[1];
    if (item.summary_image) {
      return { url: item.summary_image, media_type: "image" };
    }
    return null;
  }

  /** 媒体槽：第 3 条（方案简述图/视频） */
  function pickDetailSummary(item) {
    if (item.detail_summary && item.detail_summary.url) {
      return item.detail_summary;
    }
    var media = item.media || [];
    if (media[2] && media[2].url) return media[2];
    return null;
  }

  /** 产品/案例：主图 → ATS 风格正文（description 段落 + 键值行） */
  function isAttrKeyLine(line) {
    var s = String(line || "").trim();
    if (!s || s.length > 80) return false;
    var m = s.match(
      /^([\u4e00-\u9fffA-Za-z0-9_/\-（）()]{1,16})[:：]\s*(.*)$/
    );
    if (!m) return false;
    var label = m[1].trim();
    var value = (m[2] || "").trim();
    if (!label) return false;
    if (value && value.length > 48 && /[。！？]/.test(value)) return false;
    return true;
  }

  function parseAttrBlockLines(lines) {
    var attrs = [];
    var i = 0;
    while (i < lines.length) {
      var t = String(lines[i] || "").trim();
      i += 1;
      if (!t) continue;
      if (!isAttrKeyLine(t)) {
        if (attrs.length) {
          attrs[attrs.length - 1].value =
            attrs[attrs.length - 1].value + "\n" + t;
        }
        continue;
      }
      var m = t.match(
        /^([\u4e00-\u9fffA-Za-z0-9_/\-（）()]{1,16})[:：]\s*(.*)$/
      );
      var label = m[1].trim();
      var value = (m[2] || "").trim();
      if (!value) {
        while (i < lines.length) {
          var n = String(lines[i] || "").trim();
          if (!n) {
            i += 1;
            if (value) break;
            continue;
          }
          if (isAttrKeyLine(n)) break;
          value = value ? value + "\n" + n : n;
          i += 1;
        }
      }
      if (label && value) attrs.push({ label: label, value: value });
    }
    return attrs;
  }

  /** 说明：正文 + 末尾「输出：\n21-150 ppm」类键值 */
  function splitDescriptionBodyAndAttrs(text) {
    var raw = String(text || "").replace(/\r\n/g, "\n");
    if (!raw.trim()) return { body: "", attrs: [] };
    var lines = raw.split("\n");
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || !isAttrKeyLine(t)) continue;
      var ok = true;
      var sawKey = false;
      for (var j = i; j < lines.length; j++) {
        var u = lines[j].trim();
        if (!u) continue;
        if (isAttrKeyLine(u)) {
          sawKey = true;
          continue;
        }
        if (!sawKey && u.length > 60) {
          ok = false;
          break;
        }
      }
      if (ok && sawKey) {
        start = i;
        break;
      }
    }
    if (start < 0) return { body: raw.trim(), attrs: [] };
    var body = lines.slice(0, start).join("\n").trim();
    var attrs = parseAttrBlockLines(lines.slice(start));
    if (!attrs.length) return { body: raw.trim(), attrs: [] };
    return { body: body, attrs: attrs };
  }

  function renderProductDetail(item) {
    var main =
      pickDetailHero(item) ||
      (item.cover_url ? { url: item.cover_url, media_type: "image" } : null);
    var mainImg = main && main.url ? main.url : "";
    var product = item.product || {};
    var split = splitDescriptionBodyAndAttrs(item.description || "");
    var desc = String(
      item.description_body ||
        (product && product.description_body) ||
        split.body ||
        ""
    ).trim();
    if (
      !desc &&
      item.description &&
      !(item.attrs && item.attrs.length) &&
      !(product.attrs && product.attrs.length) &&
      !split.attrs.length
    ) {
      desc = String(item.description).trim();
    }
    var attrs =
      (item.attrs && item.attrs.length
        ? item.attrs
        : product.attrs && product.attrs.length
          ? product.attrs
          : split.attrs) || [];
    // API 已拆 body 但仍可能只给了 attrs：用 split 补正文；两边都有时合并缺键
    if (split.attrs.length) {
      var seen = {};
      attrs.forEach(function (a) {
        if (a && a.label) seen[String(a.label).toLowerCase()] = true;
      });
      split.attrs.forEach(function (a) {
        if (!a || !a.value) return;
        var k = String(a.label || "").toLowerCase();
        if (k && seen[k]) return;
        if (k) seen[k] = true;
        attrs = attrs.concat([a]);
      });
    }
    var applications =
      (item.applications && item.applications.length
        ? item.applications
        : product.applications) || [];
    var features =
      (item.features && item.features.length
        ? item.features
        : product.features) || [];
    var highlight = String(
      item.highlight || product.highlight || ""
    ).trim();
    var specs = String(item.specs || "").trim();
    var model = String(item.model || "").trim();

    var kv = attrs.slice();
    // 型号已作大标题展示，不再塞进特征键值网格
    if (!attrs.length && specs && !/[:：]/.test(specs.split("\n")[0] || "")) {
      kv.push({ label: t("规格", "Specs"), value: specs });
    }

    var html =
      '<article class="ss-product">' +
      '<header class="ss-product-bar">' +
      '<button type="button" class="ss-product-back" id="ssProductBack" aria-label="' +
      esc(t("返回列表", "Back to list")) +
      '" title="' +
      esc(t("返回列表", "Back to list")) +
      '">←</button>' +
      "</header>";

    if (mainImg) {
      html +=
        '<div class="ss-product-hero">' +
        mediaTag(mainImg, item.name) +
        "</div>";
    } else {
      html +=
        '<div class="ss-product-hero ss-product-hero--empty" aria-hidden="true"></div>';
    }

    html += '<div class="ss-product-body">';
    // ATS：型号大标题在「特征」之前；无型号时回退名称
    var headline = model || String(item.name || "").trim();
    if (headline) {
      html +=
        '<h1 class="ss-product-model">' + esc(headline) + "</h1>";
    }
    if (model && item.name && String(item.name).trim() !== model) {
      html +=
        '<p class="ss-product-name-sub">' + esc(item.name) + "</p>";
    }
    if (highlight) {
      html +=
        '<p class="ss-product-highlight">' + esc(highlight) + "</p>";
    }
    html += '<div class="ss-product-accent" aria-hidden="true"></div>';

    html +=
      '<section class="ss-product-block">' +
      '<h2 class="ss-product-h2">' +
      esc(t("特征", "Features")) +
      "</h2>";
    if (desc) {
      html +=
        '<p class="ss-product-desc">' +
        esc(desc).replace(/\n/g, "<br />") +
        "</p>";
    } else if (features.length) {
      html += renderList(features);
    } else if (!kv.length) {
      html +=
        '<p class="ss-product-empty">' +
        esc(t("暂无产品说明", "No description yet")) +
        "</p>";
    }

    if (kv.length) {
      html += '<dl class="ss-product-attrs">';
      kv.forEach(function (a) {
        if (!a || !a.value) return;
        html += "<div>";
        if (a.label) {
          html += "<dt>" + esc(a.label) + "</dt>";
        }
        html +=
          "<dd" +
          (/\n/.test(String(a.value)) ? ' class="ss-product-attrs-pre"' : "") +
          ">" +
          esc(a.value).replace(/\n/g, "<br />") +
          "</dd></div>";
      });
      html += "</dl>";
    }
    html += "</section>";

    if (applications.length) {
      html +=
        '<section class="ss-product-block">' +
        '<h2 class="ss-product-h2">' +
        esc(t("推荐用于", "Recommended for")) +
        "</h2>" +
        renderList(applications) +
        "</section>";
    }

    html += "</div></article>";
    return html;
  }

  function renderSolutionDetail(item) {
    var sol = item.solution || {};
    var hero = sol.hero || {};
    var summary = sol.summary || {};
    var overview = sol.overview || {};
    var advantages = sol.advantages || [];
    // 第 2 条 → 斜切主图；第 3 条 → 简述配图/视频（勿用第 1 条缩略图）
    var heroMedia = pickDetailHero(item);
    var summaryMedia = pickDetailSummary(item);
    var specs = String(item.specs || "").trim();

    var html = "";

    html +=
      '<div class="ss-detail-bar">' +
      '<button type="button" class="ss-product-back" id="ssProductBack" aria-label="' +
      esc(t("返回列表", "Back to list")) +
      '" title="' +
      esc(t("返回列表", "Back to list")) +
      '">←</button></div>';

    html +=
      '<section class="ss-hero">' +
      '<div class="ss-hero-copy">' +
      (sol.tag
        ? '<p class="ss-hero-tag">' + esc(sol.tag) + "</p>"
        : "") +
      '<h1 class="ss-hero-title">' +
      esc(item.name) +
      "</h1>";
    if (hero.lead) {
      html += '<p class="ss-hero-lead">' + esc(hero.lead) + "</p>";
    }
    if (hero.sublead) {
      html += '<p class="ss-hero-lead">' + esc(hero.sublead) + "</p>";
    }
    if (!hero.lead && !hero.sublead && item.blurb) {
      html += '<p class="ss-hero-lead">' + esc(item.blurb) + "</p>";
    }
    html += "</div>";
    if (heroMedia && heroMedia.url) {
      html +=
        '<div class="ss-hero-media">' +
        mediaEmbed(heroMedia, item.name) +
        "</div>";
    }
    html += "</section>";

    if (
      summary.lead ||
      (summary.highlights && summary.highlights.length) ||
      (summaryMedia && summaryMedia.url)
    ) {
      html += '<section class="ss-summary">';
      if (summaryMedia && summaryMedia.url) {
        html +=
          '<div class="ss-summary-media">' +
          mediaEmbed(summaryMedia, item.name) +
          "</div>";
      }
      html +=
        '<div class="ss-summary-copy">' +
        '<h2 class="ss-summary-title">' +
        esc(item.name) +
        "</h2>";
      if (summary.lead) {
        html += '<p class="ss-summary-lead">' + esc(summary.lead) + "</p>";
      }
      if (summary.highlights && summary.highlights.length) {
        html += renderList(summary.highlights);
      }
      html += "</div></section>";
    }

    var hasOverview =
      (overview.features && overview.features.length) ||
      (overview.applications && overview.applications.length) ||
      (overview.recommended_for && overview.recommended_for.length) ||
      specs;

    if (hasOverview) {
      html +=
        '<section class="ss-overview">' +
        '<div class="ss-tabs" role="tablist">' +
        '<button type="button" class="ss-tab is-active" data-tab="overview" role="tab" aria-selected="true">' +
        esc(t("概述", "Overview")) +
        "</button>" +
        '<button type="button" class="ss-tab" data-tab="specs" role="tab" aria-selected="false"' +
        (specs ? "" : " hidden") +
        ">" +
        esc(t("规格", "Specs")) +
        "</button>" +
        "</div>" +
        '<div class="ss-overview-panels">' +
        '<div class="ss-overview-panel" data-panel="overview" role="tabpanel">' +
        '<div class="ss-overview-cols">' +
        '<div class="ss-overview-col"><h3>' +
        esc(t("特征", "Features")) +
        "</h3>" +
        renderList(overview.features || []) +
        "</div>" +
        '<div class="ss-overview-col"><h3>' +
        esc(t("应用", "Applications")) +
        "</h3>" +
        renderList(overview.applications || []) +
        "</div>" +
        '<div class="ss-overview-col"><h3>' +
        esc(t("推荐用于", "Recommended for")) +
        "</h3>" +
        renderList(overview.recommended_for || []) +
        "</div>" +
        "</div></div>" +
        '<div class="ss-overview-panel" data-panel="specs" role="tabpanel" hidden>' +
        '<div class="ss-specs">' +
        esc(specs || t("暂无规格说明", "No specifications yet")) +
        "</div></div></div></section>";
    }

    if (advantages.length) {
      html +=
        '<section class="ss-advantages">' +
        '<h2 class="ss-advantages-title">' +
        esc(t("主要优势", "Key advantages")) +
        "</h2>" +
        '<div class="ss-advantages-grid">';
      advantages.forEach(function (adv) {
        html +=
          '<article class="ss-advantage-card">' +
          '<div class="ss-advantage-icon" aria-hidden="true"><span></span><span></span><span></span></div>' +
          "<h4>" +
          esc(adv.title) +
          "</h4>" +
          (adv.body ? "<p>" + esc(adv.body) + "</p>" : "") +
          "</article>";
      });
      html += "</div></section>";
    }

    // 第 1–3 条已用于缩略/斜切/简述，图集从第 4 条起
    var gallery = (item.media || []).filter(function (m, i) {
      return i >= 3 && m && m.url;
    });
    if (gallery.length) {
      html +=
        '<section class="ss-gallery"><h3>' +
        esc(t("图集与视频", "Gallery")) +
        '</h3><div class="ss-gallery-grid">';
      gallery.forEach(function (m) {
        html += mediaEmbed(m, m.caption || item.name);
      });
      html += "</div></section>";
    }

    return html;
  }

  function renderDetail(item) {
    if (!item) return "";
    if (item.kind === "solution") return renderSolutionDetail(item);
    return renderProductDetail(item);
  }

  function bindDetailTabs() {
    if (!detailEl) return;
    var tabs = detailEl.querySelectorAll(".ss-tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var name = tab.getAttribute("data-tab");
        tabs.forEach(function (tb) {
          var on = tb.getAttribute("data-tab") === name;
          tb.classList.toggle("is-active", on);
          tb.setAttribute("aria-selected", on ? "true" : "false");
        });
        detailEl.querySelectorAll(".ss-overview-panel").forEach(function (p) {
          var on = p.getAttribute("data-panel") === name;
          p.hidden = !on;
        });
      });
    });
  }

  function bindDetailChrome() {
    if (!detailEl) return;
    var back = detailEl.querySelector("#ssProductBack");
    if (back) {
      back.addEventListener("click", function () {
        showHitsList();
      });
    }
  }

  function notifyItemOpen(item) {
    try {
      document.dispatchEvent(
        new CustomEvent("hzdv:catalog-item-open", {
          detail: {
            id: item.id,
            name: item.name,
            kind: item.kind,
            model: item.model || "",
            item: item,
          },
        })
      );
    } catch (e) {}
  }

  function showHitsList() {
    ensureRoot();
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
    }
    state.activeId = null;
    state.activeItem = null;
    if (recommendEl && state.hits.length) {
      recommendEl.hidden = false;
      recommendEl.removeAttribute("hidden");
      recommendEl.querySelectorAll(".ss-recommend-card").forEach(function (card) {
        card.classList.remove("is-active");
      });
    } else if (emptyEl) {
      emptyEl.hidden = false;
    }
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function showDetail(item) {
    ensureRoot();
    if (!detailEl || !item) return;
    state.activeId = item.id;
    state.activeItem = item;
    setShowcaseVisible(true);
    if (emptyEl) emptyEl.hidden = true;
    if (recommendEl) {
      recommendEl.hidden = true;
      recommendEl.setAttribute("hidden", "");
    }
    detailEl.hidden = false;
    detailEl.removeAttribute("hidden");
    detailEl.innerHTML = renderDetail(item);
    bindDetailTabs();
    bindDetailChrome();
    notifyItemOpen(item);
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function renderRecommend(items, query) {
    ensureRoot();
    if (!recommendEl) return;
    var strip = recommendEl.querySelector("#ssRecommendStrip");
    var titleEl = recommendEl.querySelector("#ssRecommendTitle");
    var tableWrap = recommendEl.querySelector("#ssRecommendTableWrap");
    if (!items || !items.length) {
      recommendEl.hidden = true;
      return;
    }
    state.hits = items.slice();
    setShowcaseVisible(true);
    if (emptyEl) emptyEl.hidden = true;
    recommendEl.hidden = false;
    recommendEl.removeAttribute("hidden");
    // 缩略图页不展示表格
    if (tableWrap) {
      tableWrap.hidden = true;
      tableWrap.setAttribute("hidden", "");
      var tbody = tableWrap.querySelector("#ssRecommendTbody");
      if (tbody) tbody.innerHTML = "";
    }
    if (titleEl) {
      titleEl.textContent = query
        ? t("为您找到 ", "Found ") +
          items.length +
          t(" 条（「", " for 「") +
          query +
          t("」）— 点击缩略图查看详情", "」 — tap a thumbnail for details")
        : t("推荐结果 — 点击缩略图查看详情", "Results — tap a thumbnail for details");
    }
    if (!strip) return;
    strip.innerHTML = "";
    items.forEach(function (item) {
      var card = document.createElement("button");
      card.type = "button";
      card.className =
        "ss-recommend-card" + (state.activeId === item.id ? " is-active" : "");
      card.setAttribute("data-id", item.id);
      card.setAttribute("title", item.name || "");
      var img = item.cover_url || item.hero_image || "";
      card.innerHTML =
        (img
          ? mediaTag(img, item.name)
          : '<div class="ss-recommend-card-ph" aria-hidden="true"></div>') +
        '<div class="ss-recommend-card-body"><h3>' +
        esc(item.name) +
        "</h3></div>";
      card.addEventListener("click", function () {
        if (item.id === state.activeId && state.activeItem) {
          showDetail(state.activeItem);
        } else {
          loadItem(item.id);
        }
      });
      strip.appendChild(card);
    });
  }

  function loadItem(id) {
    if (!id) return Promise.resolve(null);
    return fetchJson(apiUrl({ id: id })).then(function (pack) {
      if (!pack.ok || !pack.j.item) return null;
      showDetail(pack.j.item);
      return pack.j.item;
    });
  }

  function showHits(items, query) {
    if (!ensureRoot()) {
      try {
        console.warn("[showcase] #site-content missing");
      } catch (e0) {}
      return;
    }
    document.body.classList.add("workspace-agent-open");
    setShowcaseVisible(true);
    renderRecommend(items, query);
    // 缩略图页只列卡片，不自动展开详情（含单条）
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
      state.activeId = null;
      state.activeItem = null;
    }
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function searchCatalog(query, opts) {
    opts = opts || {};
    var kind = opts.kind || "solution";
    var topK = opts.topK || 2;
    var q = String(query || "").trim();
    if (!q) return Promise.resolve([]);
    return fetchJson(apiUrl({ q: q, kind: kind, topK: topK })).then(function (pack) {
      if (!pack.ok || !pack.j.items) return [];
      return pack.j.items;
    });
  }

  function clear() {
    state.hits = [];
    state.activeId = null;
    state.activeItem = null;
    document.body.classList.remove("workspace-has-showcase");
    if (recommendEl) {
      recommendEl.hidden = true;
      recommendEl.setAttribute("hidden", "");
    }
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.setAttribute("hidden", "");
      detailEl.innerHTML = "";
    }
    if (emptyEl) emptyEl.hidden = false;
    var hero = document.getElementById("site-hero");
    if (hero) hero.classList.remove("is-workspace-hidden");
    var el = document.getElementById("site-content");
    if (el && !document.body.classList.contains("workspace-agent-open")) {
      el.hidden = true;
      el.setAttribute("hidden", "");
      el.setAttribute("aria-hidden", "true");
    }
  }

  global.SolutionShowcase = {
    showHits: showHits,
    showItem: loadItem,
    search: searchCatalog,
    clear: clear,
    ensureRoot: ensureRoot,
    showList: showHitsList,
  };

  document.addEventListener("hzdv:catalog-hits", function (e) {
    var d = (e && e.detail) || {};
    if (d.items && d.items.length) {
      showHits(d.items, d.query || "");
    }
  });

  document.addEventListener("hzdv:show-solution", function (e) {
    var id = e && e.detail && e.detail.id;
    if (id) loadItem(id);
  });

  function boot() {
    try {
      ensureRoot();
    } catch (err) {
      try {
        console.warn("[showcase] ensureRoot failed", err);
      } catch (e0) {}
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();
})(typeof window !== "undefined" ? window : this);
