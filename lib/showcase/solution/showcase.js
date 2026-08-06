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

  function renderList(items, title) {
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

  function renderDetail(item) {
    if (!item) return "";
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
        "</h3><div class="ss-gallery-grid">";
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

  function showDetail(item) {
    ensureRoot();
    if (!detailEl || !item) return;
    state.activeId = item.id;
    state.activeItem = item;
    setShowcaseVisible(true);
    if (emptyEl) emptyEl.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = renderDetail(item);
    bindDetailTabs();
    if (recommendEl && state.hits.length) {
      recommendEl.querySelectorAll(".ss-recommend-card").forEach(function (card) {
        card.classList.toggle(
          "is-active",
          card.getAttribute("data-id") === item.id
        );
      });
    }
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function kindLabel(kind) {
    if (kind === "solution") return t("方案", "Solution");
    if (kind === "case") return t("案例", "Case");
    return t("产品", "Product");
  }

  function renderRecommend(items, query) {
    ensureRoot();
    if (!recommendEl) return;
    var strip = recommendEl.querySelector("#ssRecommendStrip");
    var titleEl = recommendEl.querySelector("#ssRecommendTitle");
    var tableWrap = recommendEl.querySelector("#ssRecommendTableWrap");
    var tbody = recommendEl.querySelector("#ssRecommendTbody");
    if (!items || !items.length) {
      recommendEl.hidden = true;
      return;
    }
    state.hits = items.slice();
    setShowcaseVisible(true);
    if (emptyEl) emptyEl.hidden = true;
    recommendEl.hidden = false;
    recommendEl.removeAttribute("hidden");
    if (titleEl) {
      titleEl.textContent = query
        ? t("为您找到 ", "Found ") +
          items.length +
          t(" 条（「", " for 「") +
          query +
          t("」）— 点击缩略图或表格行查看详情", "」 — tap a card or row for details")
        : t("推荐结果 — 点击查看详情", "Results — tap for details");
    }
    if (!strip) return;
    strip.innerHTML = "";
    items.forEach(function (item) {
      var card = document.createElement("button");
      card.type = "button";
      card.className =
        "ss-recommend-card" + (state.activeId === item.id ? " is-active" : "");
      card.setAttribute("data-id", item.id);
      var img = item.cover_url || item.hero_image || "";
      card.innerHTML =
        (img ? mediaTag(img, item.name) : "") +
        '<div class="ss-recommend-card-body"><h3>' +
        esc(item.name) +
        "</h3><p>" +
        esc(item.blurb || "") +
        "</p></div>";
      card.addEventListener("click", function () {
        if (item.id === state.activeId && state.activeItem) {
          showDetail(state.activeItem);
        } else {
          loadItem(item.id);
        }
      });
      strip.appendChild(card);
    });

    if (tableWrap && tbody) {
      tbody.innerHTML = "";
      items.forEach(function (item) {
        var tr = document.createElement("tr");
        tr.className =
          "ss-recommend-row" + (state.activeId === item.id ? " is-active" : "");
        tr.setAttribute("data-id", item.id);
        tr.innerHTML =
          "<td>" +
          esc(kindLabel(item.kind)) +
          "</td><td>" +
          esc(item.name || "") +
          "</td><td>" +
          esc(item.model || "—") +
          "</td><td>" +
          esc(item.blurb || "—") +
          "</td>";
        tr.addEventListener("click", function () {
          loadItem(item.id);
        });
        tbody.appendChild(tr);
      });
      tableWrap.hidden = false;
    }
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
    // 多条时只展示缩略图+表格，等用户点开；单条才自动展开详情
    if (items && items.length === 1) {
      loadItem(items[0].id);
    } else if (detailEl) {
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

  document.addEventListener("DOMContentLoaded", ensureRoot);
  if (document.readyState !== "loading") ensureRoot();

  global.SolutionShowcase = {
    showHits: showHits,
    showItem: loadItem,
    search: searchCatalog,
    clear: clear,
    ensureRoot: ensureRoot,
  };
})(typeof window !== "undefined" ? window : this);
