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

  /** 产品/案例：图(第2张) → 规格型号 → 特点 / 适用场景 */
  function renderProductDetail(item) {
    var mainImg =
      item.summary_image || item.hero_image || item.cover_url || "";
    var product = item.product || {};
    var features =
      (item.features && item.features.length
        ? item.features
        : product.features) || [];
    var applications =
      (item.applications && item.applications.length
        ? item.applications
        : product.applications) || [];
    if (!features.length && item.description) {
      features = String(item.description)
        .split(/\r?\n/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }
    var specs = String(item.specs || "").trim();
    var model = String(item.model || "").trim();

    var html =
      '<article class="ss-product">' +
      '<header class="ss-product-bar">' +
      '<button type="button" class="ss-product-back" id="ssProductBack">' +
      esc(t("← 返回列表", "← Back to list")) +
      "</button>" +
      '<h1 class="ss-product-name">' +
      esc(item.name) +
      "</h1>" +
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

    html +=
      '<section class="ss-product-specs">' +
      "<h2>" +
      esc(t("规格型号", "Specs & model")) +
      "</h2>" +
      '<dl class="ss-product-spec-dl">';
    if (model) {
      html +=
        "<div><dt>" +
        esc(t("型号", "Model")) +
        "</dt><dd>" +
        esc(model) +
        "</dd></div>";
    }
    if (specs) {
      html +=
        "<div><dt>" +
        esc(t("规格", "Specs")) +
        '</dt><dd class="ss-product-specs-body">' +
        esc(specs) +
        "</dd></div>";
    }
    if (!model && !specs) {
      html +=
        "<div><dd>" +
        esc(t("暂无规格型号", "No model or specs yet")) +
        "</dd></div>";
    }
    html += "</dl></section>";

    html += '<section class="ss-product-cols">';
    html +=
      '<div class="ss-product-col"><h2>' +
      esc(t("特点", "Features")) +
      "</h2>" +
      (features.length
        ? renderList(features)
        : "<p class=\"ss-product-empty\">" +
          esc(t("暂无特点说明", "No features yet")) +
          "</p>") +
      "</div>";
    html +=
      '<div class="ss-product-col"><h2>' +
      esc(t("适用场景", "Applications")) +
      "</h2>" +
      (applications.length
        ? renderList(applications)
        : "<p class=\"ss-product-empty\">" +
          esc(t("暂无适用场景", "No applications yet")) +
          "</p>") +
      "</div>";
    html += "</section></article>";
    return html;
  }

  function renderSolutionDetail(item) {
    var sol = item.solution || {};
    var hero = sol.hero || {};
    var summary = sol.summary || {};
    var overview = sol.overview || {};
    var advantages = sol.advantages || [];
    var heroImg = item.hero_image || item.cover_url || "";
    var summaryImg = item.summary_image || heroImg;
    var specs = String(item.specs || "").trim();

    var html = "";

    html +=
      '<div class="ss-detail-bar">' +
      '<button type="button" class="ss-product-back" id="ssProductBack">' +
      esc(t("← 返回列表", "← Back to list")) +
      "</button></div>";

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
    if (heroImg) {
      html +=
        '<div class="ss-hero-media">' + mediaTag(heroImg, item.name) + "</div>";
    }
    html += "</section>";

    if (
      summary.lead ||
      (summary.highlights && summary.highlights.length) ||
      summaryImg
    ) {
      html += '<section class="ss-summary">';
      if (summaryImg) {
        html +=
          '<div class="ss-summary-media">' +
          mediaTag(summaryImg, item.name) +
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

    var gallery = (item.media || []).filter(function (m, i) {
      if (i < 2 && m.media_type === "image") return false;
      return true;
    });
    if (gallery.length) {
      html +=
        '<section class="ss-gallery"><h3>' +
        esc(t("图集与视频", "Gallery")) +
        '</h3><div class="ss-gallery-grid">';
      gallery.forEach(function (m) {
        if (m.media_type === "video") {
          html +=
            '<video src="' +
            esc(m.url) +
            '" controls playsinline preload="metadata"></video>';
        } else {
          html += mediaTag(m.url, m.caption || item.name);
        }
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
    if (recommendEl) recommendEl.hidden = true;
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
    }
    if (emptyEl) emptyEl.hidden = false;
    var hero = document.getElementById("site-hero");
    if (hero && !document.body.classList.contains("workspace-agent-open")) {
      hero.classList.remove("is-workspace-hidden");
    }
    var el = document.getElementById("site-content");
    if (el && !document.body.classList.contains("workspace-agent-open")) {
      el.hidden = true;
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
