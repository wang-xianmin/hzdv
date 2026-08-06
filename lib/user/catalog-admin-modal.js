/**
 * 产品目录管理（运维）
 * 入口：系统运维 → 产品目录
 * AG Grid 编辑文字；媒体列缩略图；抽屉内 Ctrl+V / 拖拽 / 选文件。
 */
(function () {
  "use strict";

  var overlay = null;
  var gridEl = null;
  var statusEl = null;
  var drawerEl = null;
  var drawerStripEl = null;
  var drawerHintEl = null;
  var gridApi = null;
  var cache = [];
  var activeItemId = null;
  var drawerMode = "media";
  var fileInput = null;

  function t(zh, en) {
    if (window.currentLang === "en") return en;
    var htmlLang = String(document.documentElement.lang || "").toLowerCase();
    return htmlLang.indexOf("en") === 0 ? en : zh;
  }

  function currentPhone() {
    try {
      if (window.__LENG_USER && window.__LENG_USER.phone) {
        return String(window.__LENG_USER.phone);
      }
      if (typeof window.getCurrentUserPhone === "function") {
        var p = window.getCurrentUserPhone();
        if (p) return String(p);
      }
      var raw = localStorage.getItem("leng_user");
      if (!raw) return "";
      var u = JSON.parse(raw);
      return String((u && u.phone) || "");
    } catch (e) {
      return "";
    }
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className =
      "catalog-admin-status" +
      (kind === "error"
        ? " is-error"
        : kind === "ok"
          ? " is-ok"
          : "");
  }

  function api(method, body) {
    var phone = currentPhone();
    var opts = {
      method: method,
      cache: "no-store",
      headers: {},
    };
    if (body instanceof FormData) {
      if (!body.has("phone")) body.append("phone", phone);
      opts.body = body;
    } else if (body) {
      opts.headers["Content-Type"] = "application/json";
      body.phone = phone;
      opts.body = JSON.stringify(body);
    }
    var url = "/api/catalog-admin";
    if (method === "GET") {
      url += "?phone=" + encodeURIComponent(phone);
    }
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, status: r.status, j: j || {} };
      });
    });
  }

  function ensureUi() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "catalog-admin-overlay";
    overlay.id = "catalogAdminOverlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="catalog-admin-dialog" role="dialog" aria-modal="true" aria-labelledby="catalogAdminTitle">' +
      '<div class="catalog-admin-head">' +
      '<h2 id="catalogAdminTitle">' +
      t("产品目录", "Product Catalog") +
      "</h2>" +
      '<button type="button" class="catalog-admin-close" id="catalogAdminClose" aria-label="关闭">&times;</button>' +
      "</div>" +
      '<p class="catalog-admin-hint" id="catalogAdminHint"></p>' +
      '<div class="catalog-admin-actions">' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminAdd">' +
      t("新增产品", "Add product") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminEditExt">' +
      "EXT_JSON" +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminEditDesc">' +
      t("说明", "Description") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminReload">' +
      t("刷新", "Reload") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminReindex">' +
      t("重建向量索引", "Rebuild vectors") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminTrySearch">' +
      t("试搜", "Trial search") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminSynonyms">' +
      t("同义词", "Synonyms") +
      "</button>" +
      "</div>" +
      '<div class="catalog-admin-synonyms" id="catalogAdminSynonymsPanel" hidden>' +
      '<p class="catalog-admin-drawer-hint" id="catalogAdminSynonymsHint"></p>' +
      '<div id="catalogAdminSynonymsFields"></div>' +
      '<div class="catalog-admin-actions" style="padding-left:0">' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminSynonymsSave">' +
      t("保存同义词", "Save synonyms") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminSynonymsClose">' +
      t("关闭", "Close") +
      "</button>" +
      "</div></div>" +
      '<div class="catalog-admin-grid ag-theme-quartz" id="catalogAdminGrid"></div>' +
      '<p class="catalog-admin-status" id="catalogAdminStatus" aria-live="polite"></p>' +
      '<aside class="catalog-admin-drawer" id="catalogAdminDrawer" hidden>' +
      '<div class="catalog-admin-drawer-head">' +
      '<strong id="catalogAdminDrawerTitle">' +
      t("媒体", "Media") +
      "</strong>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminDrawerClose">' +
      t("关闭", "Close") +
      "</button>" +
      "</div>" +
      '<p class="catalog-admin-drawer-hint" id="catalogAdminDrawerHint"></p>' +
      '<div class="catalog-admin-drawer-tabs" id="catalogAdminDrawerTabs" hidden>' +
      '<button type="button" class="catalog-admin-drawer-tab is-active" data-tab="media">' +
      t("媒体", "Media") +
      "</button>" +
      '<button type="button" class="catalog-admin-drawer-tab" data-tab="ext">' +
      "EXT_JSON" +
      "</button>" +
      '<button type="button" class="catalog-admin-drawer-tab" data-tab="description">' +
      t("说明", "Description") +
      "</button>" +
      "</div>" +
      '<div class="catalog-admin-solution" id="catalogAdminSolution" hidden>' +
      '<label class="catalog-admin-field"><span>' +
      t("分类标签", "Category tag") +
      '</span><input type="text" id="catSolTag" /></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("简介句 1（Hero）", "Intro line 1 (hero)") +
      '</span><textarea id="catSolHeroLead" rows="2"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("简介句 2（Hero）", "Intro line 2 (hero)") +
      '</span><textarea id="catSolHeroSub" rows="2"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("简述导语（屏 2）", "Summary lead") +
      '</span><textarea id="catSolSumLead" rows="2"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("简述要点（每行一条）", "Summary bullets (one per line)") +
      '</span><textarea id="catSolSumHi" rows="4"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("特征（每行一条）", "Features (one per line)") +
      '</span><textarea id="catSolFeat" rows="4"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("应用（每行一条）", "Applications (one per line)") +
      '</span><textarea id="catSolApp" rows="4"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("推荐用于（每行一条）", "Recommended for (one per line)") +
      '</span><textarea id="catSolRec" rows="4"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("主要优势（每行：标题：正文）", "Advantages (one per line: title: body)") +
      '</span><textarea id="catSolAdv" rows="5" placeholder="' +
      t(
        "可配置：模块最多可容纳两个工位……",
        "Configurable: Modules can hold up to two stations…"
      ) +
      '"></textarea></label>' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminSolutionSave">' +
      t("保存方案 EXT_JSON", "Save solution EXT_JSON") +
      "</button>" +
      "</div>" +
      '<div class="catalog-admin-product-ext" id="catalogAdminProductExt" hidden>' +
      '<label class="catalog-admin-field"><span>' +
      t("亮点标题（可选）", "Highlight (optional)") +
      '</span><input type="text" id="catProdHighlight" placeholder="' +
      t("如：输出水平最高可达 150 PPM", "e.g. Output up to 150 PPM") +
      '" /></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("特征键值（每行：键：值）", "Feature attrs (one per line: key: value)") +
      '</span><textarea id="catProdAttrs" rows="6" placeholder="' +
      t("输出：21-150 ppm\n平台：SuperTrak™ 输送", "Output: 21-150 ppm\nPlatform: SuperTrak") +
      '"></textarea></label>' +
      '<label class="catalog-admin-field"><span>' +
      t("推荐用于（每行一条）", "Recommended for (one per line)") +
      '</span><textarea id="catProdRec" rows="5" placeholder="' +
      t("制药\n医疗器械", "Pharma\nMedical devices") +
      '"></textarea></label>' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminProductSave">' +
      t("保存产品 EXT_JSON", "Save product EXT_JSON") +
      "</button>" +
      "</div>" +
      '<div class="catalog-admin-description" id="catalogAdminDescription" hidden>' +
      '<label class="catalog-admin-field"><span>' +
      t("说明（特征正文；可在末尾加键值行）", "Description (feature prose; optional key lines at end)") +
      '</span><textarea id="catDescText" rows="12" placeholder="' +
      t(
        "预先设计、高度标准化……\n\n输出：\n21-150 ppm\n平台：\nSuperTrak™ 输送",
        "Prose first…\n\nOutput:\n21-150 ppm\nPlatform:\nSuperTrak"
      ) +
      '"></textarea></label>' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminDescSave">' +
      t("保存说明", "Save description") +
      "</button>" +
      "</div>" +
      '<div class="catalog-admin-drawer-media" id="catalogAdminDrawerMedia">' +
      '<div class="catalog-admin-drop" id="catalogAdminDrop" tabindex="0">' +
      '<div class="catalog-admin-strip" id="catalogAdminStrip"></div>' +
      '<p class="catalog-admin-drop-tip" id="catalogAdminDropTip"></p>' +
      "</div>" +
      '<div class="catalog-admin-drawer-actions">' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminPickFile">' +
      t("选择文件", "Choose file") +
      "</button>" +
      "</div>" +
      "</div>" +
      "</aside>" +
      '<input type="file" id="catalogAdminFile" accept="image/*,video/mp4,video/webm,video/quicktime" hidden multiple />' +
      "</div>";
    document.body.appendChild(overlay);

    gridEl = overlay.querySelector("#catalogAdminGrid");
    statusEl = overlay.querySelector("#catalogAdminStatus");
    drawerEl = overlay.querySelector("#catalogAdminDrawer");
    drawerStripEl = overlay.querySelector("#catalogAdminStrip");
    drawerHintEl = overlay.querySelector("#catalogAdminDrawerHint");
    fileInput = overlay.querySelector("#catalogAdminFile");

    overlay.querySelector("#catalogAdminHint").textContent = t(
      "选中一行后：EXT_JSON 编辑方案四屏或产品键值/推荐用于；「说明」编辑特征正文。媒体列管理图视频。",
      "Select a row: EXT_JSON edits solution screens or product attrs/recommended-for; Description edits feature prose. Media column for files."
    );
    overlay.querySelector("#catalogAdminDropTip").textContent = t(
      "按顺序上传：①缩略图 ②详情/斜切主图 ③方案简述图或视频 · 粘贴/拖入/选文件",
      "Order: #1 thumb · #2 detail/diagonal · #3 summary image/video · paste / drop / choose"
    );

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#catalogAdminClose").addEventListener("click", close);
    overlay.querySelector("#catalogAdminReload").addEventListener("click", function () {
      load(true);
    });
    overlay.querySelector("#catalogAdminAdd").addEventListener("click", addRow);
    overlay
      .querySelector("#catalogAdminEditExt")
      .addEventListener("click", editExtJson);
    overlay
      .querySelector("#catalogAdminEditDesc")
      .addEventListener("click", editDescription);
    overlay
      .querySelector("#catalogAdminReindex")
      .addEventListener("click", reindexAll);
    overlay
      .querySelector("#catalogAdminTrySearch")
      .addEventListener("click", trySearch);
    overlay
      .querySelector("#catalogAdminSynonyms")
      .addEventListener("click", openSynonymsPanel);
    overlay
      .querySelector("#catalogAdminSynonymsSave")
      .addEventListener("click", saveSynonymsPanel);
    overlay
      .querySelector("#catalogAdminSynonymsClose")
      .addEventListener("click", closeSynonymsPanel);
    overlay.querySelector("#catalogAdminSynonymsHint").textContent = t(
      "规范词固定为产品/方案/案例；同义词用逗号或换行分隔。保存后若要向量检索立刻生效，请再点「重建向量索引」。",
      "Canonical kinds are fixed; aliases comma/newline separated. After save, rebuild vectors for search to pick up new terms."
    );
    overlay
      .querySelector("#catalogAdminDrawerClose")
      .addEventListener("click", closeDrawer);
    overlay
      .querySelector("#catalogAdminSolutionSave")
      .addEventListener("click", saveSolutionContent);
    overlay
      .querySelector("#catalogAdminProductSave")
      .addEventListener("click", saveProductExt);
    overlay
      .querySelector("#catalogAdminDescSave")
      .addEventListener("click", saveDescription);
    var drawerTabs = overlay.querySelector("#catalogAdminDrawerTabs");
    if (drawerTabs) {
      drawerTabs.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest("[data-tab]");
        if (!btn) return;
        setDrawerTab(btn.getAttribute("data-tab"));
      });
    }
    overlay
      .querySelector("#catalogAdminPickFile")
      .addEventListener("click", function () {
        if (fileInput) fileInput.click();
      });

    var drop = overlay.querySelector("#catalogAdminDrop");
    drop.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      drop.classList.add("is-drag");
    });
    drop.addEventListener("dragleave", function () {
      drop.classList.remove("is-drag");
    });
    drop.addEventListener("drop", function (ev) {
      ev.preventDefault();
      drop.classList.remove("is-drag");
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    });

    if (fileInput) {
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files.length) {
          uploadFiles(fileInput.files);
          fileInput.value = "";
        }
      });
    }

    document.addEventListener("paste", onPaste);
    return overlay;
  }

  function onPaste(ev) {
    if (!overlay || overlay.hidden || !activeItemId) return;
    if (drawerEl && drawerEl.hidden) return;
    if (drawerMode !== "media") return;
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== "file") continue;
      if (
        it.type.indexOf("image/") !== 0 &&
        it.type.indexOf("video/") !== 0
      ) {
        continue;
      }
      var raw = it.getAsFile();
      if (!raw) continue;
      if (raw.name && String(raw.name).trim()) {
        files.push(raw);
      } else {
        var subtype = String(it.type || "image/png").split("/")[1] || "png";
        if (subtype.indexOf("jpeg") >= 0) subtype = "jpg";
        files.push(
          new File([raw], "paste." + subtype, {
            type: raw.type || it.type || "image/png",
          })
        );
      }
    }
    if (!files.length) return;
    ev.preventDefault();
    uploadFiles(files);
  }

  function findItem(id) {
    for (var i = 0; i < cache.length; i++) {
      if (cache[i] && cache[i].id === id) return cache[i];
    }
    return null;
  }

  function replaceCacheItem(item) {
    if (!item || !item.id) return;
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].id === item.id) {
        cache[i] = item;
        return;
      }
    }
    cache.push(item);
  }

  function mediaThumbHtml(item) {
    var counts = (item && item.media_counts) || { image: 0, video: 0 };
    var cover = (item && item.cover_url) || "";
    if (!cover && item && item.media && item.media.length) {
      cover = item.media[0].url || "";
    }
    var badge =
      "图" +
      (counts.image || 0) +
      "·视" +
      (counts.video || 0);
    var img = cover
      ? '<img class="catalog-admin-cell-thumb" src="' +
        String(cover).replace(/"/g, "&quot;") +
        '" alt="" />'
      : '<span class="catalog-admin-cell-thumb catalog-admin-cell-thumb--empty">+</span>';
    return (
      '<button type="button" class="catalog-admin-media-btn" data-id="' +
      String(item.id).replace(/"/g, "&quot;") +
      '">' +
      img +
      '<span class="catalog-admin-media-badge">' +
      badge +
      "</span></button>"
    );
  }

  var TRASH_ICON_SVG =
    '<svg class="catalog-admin-trash-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 4h8"/><path d="M10 4V3h4v1"/><path d="M5 7h14"/><path d="M7 7v13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    "</svg>";

  function buildGrid() {
    if (!gridEl) return;
    if (typeof agGrid === "undefined" || !agGrid.createGrid) {
      setStatus(t("AG Grid 未加载", "AG Grid not loaded"), "error");
      return;
    }
    if (gridApi) {
      gridApi.setGridOption("rowData", cache.slice());
      return;
    }
    var colDefs = [
      {
        headerName: t("序号", "#"),
        colId: "_rownum",
        width: 64,
        minWidth: 52,
        maxWidth: 88,
        editable: false,
        sortable: false,
        filter: false,
        resizable: true,
        valueGetter: function (p) {
          return p.node && p.node.rowIndex != null ? p.node.rowIndex + 1 : "";
        },
        cellClass: "catalog-admin-cell-rownum",
      },
      {
        headerName: t("类型", "Kind"),
        field: "kind",
        width: 110,
        minWidth: 88,
        resizable: true,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: ["product", "solution", "case"],
        },
        valueFormatter: function (p) {
          if (p.value === "solution") return t("方案", "Solution");
          if (p.value === "case") return t("案例", "Case");
          return t("产品", "Product");
        },
      },
      {
        headerName: t("名称", "Name"),
        field: "name",
        width: 180,
        minWidth: 120,
        resizable: true,
        editable: true,
      },
      {
        headerName: t("型号", "Model"),
        field: "model",
        width: 130,
        minWidth: 90,
        resizable: true,
        editable: true,
      },
      {
        headerName: t("规格", "Specs"),
        field: "specs",
        width: 220,
        minWidth: 120,
        resizable: true,
        editable: true,
        tooltipField: "specs",
      },
      {
        headerName: t("说明", "Description"),
        field: "description",
        width: 200,
        minWidth: 120,
        resizable: true,
        editable: true,
        tooltipField: "description",
      },
      {
        headerName: t("扩展JSON", "ext_json"),
        field: "extra_json",
        width: 200,
        minWidth: 120,
        resizable: true,
        editable: true,
        tooltipField: "extra_json",
        valueFormatter: function (p) {
          var s = p.value == null ? "" : String(p.value);
          if (!s || s === "{}") return "";
          return s.length > 80 ? s.slice(0, 80) + "…" : s;
        },
      },
      {
        headerName: t("启用", "On"),
        field: "is_active",
        width: 80,
        minWidth: 64,
        resizable: true,
        editable: true,
        valueGetter: function (p) {
          return !!(p.data && Number(p.data.is_active) !== 0);
        },
        valueSetter: function (p) {
          if (!p.data) return false;
          p.data.is_active = p.newValue ? 1 : 0;
          return true;
        },
        cellRenderer: "agCheckboxCellRenderer",
        cellEditor: "agCheckboxCellEditor",
      },
      {
        headerName: t("媒体", "Media"),
        field: "media",
        width: 120,
        minWidth: 96,
        resizable: true,
        editable: false,
        cellRenderer: function (p) {
          return mediaThumbHtml(p.data || {});
        },
      },
      {
        headerName: "EXT",
        field: "_content",
        width: 88,
        minWidth: 72,
        maxWidth: 110,
        resizable: true,
        editable: false,
        sortable: false,
        cellRenderer: function (p) {
          if (!p.data || !p.data.id) return "";
          var id = String(p.data.id || "");
          return (
            '<button type="button" class="catalog-admin-content-btn" data-id="' +
            id.replace(/"/g, "&quot;") +
            '">' +
            "EXT" +
            "</button>"
          );
        },
      },
      {
        headerName: t("操作", "Ops"),
        field: "_ops",
        width: 72,
        minWidth: 56,
        maxWidth: 96,
        resizable: true,
        editable: false,
        sortable: false,
        cellClass: "catalog-admin-cell-ops",
        cellRenderer: function (p) {
          var id = p.data && p.data.id ? String(p.data.id) : "";
          return (
            '<button type="button" class="catalog-admin-del" data-id="' +
            id.replace(/"/g, "&quot;") +
            '" title="' +
            t("删除", "Delete") +
            '" aria-label="' +
            t("删除", "Delete") +
            '">' +
            TRASH_ICON_SVG +
            "</button>"
          );
        },
      },
    ];
    gridApi = agGrid.createGrid(gridEl, {
      columnDefs: colDefs,
      rowData: cache.slice(),
      getRowId: function (p) {
        return p.data && p.data.id ? String(p.data.id) : undefined;
      },
      defaultColDef: {
        resizable: true,
        sortable: true,
        suppressSizeToFit: true,
      },
      animateRows: true,
      stopEditingWhenCellsLoseFocus: true,
      tooltipShowDelay: 400,
      onCellValueChanged: function (ev) {
        if (!ev || !ev.data || !ev.data.id) return;
        if (ev.colDef && ev.colDef.colId === "_rownum") return;
        if (ev.colDef && ev.colDef.field === "media") return;
        if (ev.colDef && ev.colDef.field === "_content") return;
        if (ev.colDef && ev.colDef.field === "_ops") return;
        saveRow(ev.data);
      },
      onCellClicked: function (ev) {
        var tEl = ev.event && ev.event.target;
        if (!tEl || !tEl.closest) return;
        var mediaBtn = tEl.closest(".catalog-admin-media-btn");
        if (mediaBtn) {
          openDrawer(mediaBtn.getAttribute("data-id"), "media");
          return;
        }
        var contentBtn = tEl.closest(".catalog-admin-content-btn");
        if (contentBtn) {
          openDrawer(contentBtn.getAttribute("data-id"), "ext");
          return;
        }
        var delBtn = tEl.closest(".catalog-admin-del");
        if (delBtn) {
          deleteItem(delBtn.getAttribute("data-id"));
        }
      },
    });
  }

  function load(force) {
    ensureUi();
    setStatus(t("加载中…", "Loading…"));
    return api("GET")
      .then(function (pack) {
        if (!pack.ok || pack.j.success === false) {
          setStatus(
            (pack.j && pack.j.error) || t("加载失败", "Load failed"),
            "error"
          );
          return;
        }
        cache = Array.isArray(pack.j.items) ? pack.j.items : [];
        buildGrid();
        setStatus(
          t("共 ", "Total ") + cache.length + t(" 条", " items"),
          "ok"
        );
        if (activeItemId) {
          var item = findItem(activeItemId);
          if (item) renderDrawerMedia(item);
        }
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function indexApi(body) {
    var phone = currentPhone();
    return fetch("/api/catalog-index", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ phone: phone }, body || {})),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, status: r.status, j: j || {} };
      });
    });
  }

  function reindexAll() {
    setStatus(t("正在重建向量索引…", "Rebuilding vector index…"));
    indexApi({ action: "reindex" })
      .then(function (pack) {
        var j = pack.j || {};
        if (!pack.ok || j.success === false) {
          setStatus(
            (j.error || t("索引失败", "Index failed")) +
              (j.ai_bound === false || j.vectorize_bound === false
                ? ""
                : ""),
            "error"
          );
          return;
        }
        setStatus(
          t("索引完成：写入 ", "Indexed: upserted ") +
            (j.upserted || 0) +
            t("，删除停用 ", ", removed inactive ") +
            (j.deleted || 0) +
            (j.errors && j.errors.length
              ? " · " + j.errors.join("; ")
              : ""),
          j.errors && j.errors.length ? "error" : "ok"
        );
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function trySearch() {
    var q = window.prompt(
      t(
        "试搜：输入一句话（如「耐腐蚀阀门」）",
        "Trial search: enter a query"
      ),
      ""
    );
    if (q == null) return;
    q = String(q).trim();
    if (!q) return;
    setStatus(t("试搜中…", "Searching…"));
    indexApi({ action: "query", q: q, topK: 5 })
      .then(function (pack) {
        var j = pack.j || {};
        if (!pack.ok || j.success === false) {
          setStatus(j.error || t("试搜失败", "Search failed"), "error");
          return;
        }
        var matches = Array.isArray(j.matches) ? j.matches : [];
        if (!matches.length) {
          setStatus(t("无命中", "No hits"), "ok");
          return;
        }
        var lines = matches.map(function (m, i) {
          var md = m.metadata || {};
          return (
            i +
            1 +
            ". [" +
            (md.kind || "?") +
            "] " +
            (md.name || m.id) +
            (md.model ? " · " + md.model : "") +
            " · score=" +
            (typeof m.score === "number" ? m.score.toFixed(3) : m.score)
          );
        });
        setStatus(t("试搜结果：", "Hits: ") + lines.join(" | "), "ok");
        try {
          console.log("[catalog-index query]", matches);
        } catch (eLog) {}
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function openSynonymsPanel() {
    ensureUi();
    var panel = overlay.querySelector("#catalogAdminSynonymsPanel");
    var grid = overlay.querySelector("#catalogAdminGrid");
    if (panel) panel.hidden = false;
    if (grid) grid.style.display = "none";
    closeDrawer();
    setStatus(t("加载同义词…", "Loading synonyms…"));
    var phone = currentPhone();
    fetch(
      "/api/catalog-admin?phone=" +
        encodeURIComponent(phone) +
        "&view=synonyms",
      { cache: "no-store" }
    )
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (pack) {
        if (!pack.ok || !pack.j.synonyms) {
          setStatus(
            (pack.j && pack.j.error) || t("加载失败", "Load failed"),
            "error"
          );
          return;
        }
        renderSynonymsFields(pack.j.synonyms);
        setStatus(t("可编辑同义词后保存", "Edit aliases then save"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function closeSynonymsPanel() {
    var panel = overlay && overlay.querySelector("#catalogAdminSynonymsPanel");
    var grid = overlay && overlay.querySelector("#catalogAdminGrid");
    if (panel) panel.hidden = true;
    if (grid) grid.style.display = "";
  }

  function renderSynonymsFields(rows) {
    var host = overlay.querySelector("#catalogAdminSynonymsFields");
    if (!host) return;
    host.innerHTML = "";
    (rows || []).forEach(function (row) {
      var wrap = document.createElement("label");
      wrap.className = "catalog-admin-field";
      wrap.style.marginBottom = "10px";
      wrap.innerHTML =
        "<span>" +
        (row.label || row.canonical) +
        " (" +
        row.canonical +
        ")</span>";
      var ta = document.createElement("textarea");
      ta.rows = 2;
      ta.dataset.canonical = row.canonical;
      ta.value = (row.aliases || []).join("，");
      wrap.appendChild(ta);
      host.appendChild(wrap);
    });
  }

  function saveSynonymsPanel() {
    var host = overlay.querySelector("#catalogAdminSynonymsFields");
    if (!host) return;
    var synonyms = [];
    host.querySelectorAll("textarea[data-canonical]").forEach(function (ta) {
      synonyms.push({
        canonical: ta.getAttribute("data-canonical"),
        aliases: String(ta.value || "")
          .split(/[,，、\n]/)
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean),
      });
    });
    setStatus(t("保存同义词…", "Saving synonyms…"));
    api("PATCH", { action: "save_synonyms", synonyms: synonyms })
      .then(function (pack) {
        if (!pack.ok || pack.j.success === false) {
          setStatus(
            (pack.j && pack.j.error) || t("保存失败", "Save failed"),
            "error"
          );
          return;
        }
        if (pack.j.synonyms) renderSynonymsFields(pack.j.synonyms);
        setStatus(
          (pack.j && pack.j.hint) ||
            t(
              "已保存。需要时请重建向量索引。",
              "Saved. Rebuild vectors when needed."
            ),
          "ok"
        );
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function addRow() {
    setStatus(t("新增中…", "Creating…"));
    api("POST", {
      action: "create",
      kind: "product",
      name: t("未命名产品", "Untitled product"),
      model: "",
      specs: "",
      description: "",
      is_active: 1,
      sort_order: cache.length,
    })
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("新增失败", "Create failed"),
            "error"
          );
          return;
        }
        cache.push(pack.j.item);
        buildGrid();
        setStatus(t("已新增，可直接改单元格（自动保存）", "Created — edit cells (auto-save)"), "ok");
        if (gridApi) {
          gridApi.setFocusedCell(cache.length - 1, "name");
        }
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function saveRow(row) {
    if (!row || !row.id) return;
    var extraJson = row.extra_json == null ? "{}" : String(row.extra_json);
    if (extraJson.trim()) {
      try {
        JSON.parse(extraJson);
      } catch (eJson) {
        setStatus(
          t("扩展JSON 不是合法 JSON，请先修正", "ext_json must be valid JSON"),
          "error"
        );
        return;
      }
    } else {
      extraJson = "{}";
    }
    var payload = {
      id: row.id,
      kind: row.kind,
      name: row.name,
      model: row.model == null ? "" : String(row.model),
      specs: row.specs == null ? "" : String(row.specs),
      description: row.description == null ? "" : String(row.description),
      extra_json: extraJson,
      is_active: Number(row.is_active) !== 0 ? 1 : 0,
      sort_order: Math.max(0, Math.floor(Number(row.sort_order) || 0)),
    };
    setStatus(t("保存中…", "Saving…"));
    api("PATCH", payload)
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("保存失败", "Save failed"),
            "error"
          );
          return;
        }
        replaceCacheItem(pack.j.item);
        if (gridApi) {
          var node =
            typeof gridApi.getRowNode === "function"
              ? gridApi.getRowNode(String(pack.j.item.id))
              : null;
          if (node) {
            node.setData(pack.j.item);
          } else {
            buildGrid();
          }
        }
        setStatus(t("已保存", "Saved"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function deleteItem(id) {
    if (!id) return;
    if (
      !confirm(
        t("确定删除该条目及其媒体？", "Delete this item and its media?")
      )
    ) {
      return;
    }
    api("DELETE", { id: id })
      .then(function (pack) {
        if (!pack.ok || pack.j.success === false) {
          setStatus(
            (pack.j && pack.j.error) || t("删除失败", "Delete failed"),
            "error"
          );
          return;
        }
        cache = cache.filter(function (x) {
          return x.id !== id;
        });
        if (activeItemId === id) closeDrawer();
        buildGrid();
        setStatus(t("已删除", "Deleted"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function linesFromTextarea(el) {
    if (!el) return [];
    return String(el.value || "")
      .split(/\r?\n/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function parseAdvantagesText(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(function (line) {
        var s = line.trim();
        if (!s) return null;
        var sep = -1;
        var pipe = s.indexOf("|");
        var cn = s.indexOf("：");
        var en = s.indexOf(":");
        if (pipe >= 0) sep = pipe;
        else if (cn >= 0) sep = cn;
        else if (en >= 0) sep = en;
        if (sep >= 0) {
          return {
            title: s.slice(0, sep).trim(),
            body: s.slice(sep + 1).trim(),
          };
        }
        return { title: s, body: "" };
      })
      .filter(Boolean);
  }

  function getItemSolution(item) {
    if (!item) return null;
    if (item.solution && typeof item.solution === "object") return item.solution;
    try {
      var extra = JSON.parse(String(item.extra_json || "{}"));
      return extra.solution || null;
    } catch (e) {
      return null;
    }
  }

  function fillSolutionForm(item) {
    var sol = getItemSolution(item) || {};
    var hero = sol.hero || {};
    var summary = sol.summary || {};
    var overview = sol.overview || {};
    var set = function (id, val) {
      var el = overlay.querySelector(id);
      if (el) el.value = val == null ? "" : String(val);
    };
    set("#catSolTag", sol.tag || "");
    set("#catSolHeroLead", hero.lead || "");
    set("#catSolHeroSub", hero.sublead || "");
    set("#catSolSumLead", summary.lead || "");
    set(
      "#catSolSumHi",
      (summary.highlights || []).join("\n")
    );
    set("#catSolFeat", (overview.features || []).join("\n"));
    set("#catSolApp", (overview.applications || []).join("\n"));
    set("#catSolRec", (overview.recommended_for || []).join("\n"));
    set(
      "#catSolAdv",
      (sol.advantages || [])
        .map(function (a) {
          if (!a) return "";
          if (a.body) return (a.title || "") + "：" + a.body;
          return a.title || "";
        })
        .join("\n")
    );
  }

  function readSolutionForm() {
    return {
      tag: overlay.querySelector("#catSolTag").value.trim(),
      hero: {
        lead: overlay.querySelector("#catSolHeroLead").value.trim(),
        sublead: overlay.querySelector("#catSolHeroSub").value.trim(),
      },
      summary: {
        lead: overlay.querySelector("#catSolSumLead").value.trim(),
        highlights: linesFromTextarea(overlay.querySelector("#catSolSumHi")),
      },
      overview: {
        features: linesFromTextarea(overlay.querySelector("#catSolFeat")),
        applications: linesFromTextarea(overlay.querySelector("#catSolApp")),
        recommended_for: linesFromTextarea(overlay.querySelector("#catSolRec")),
      },
      advantages: parseAdvantagesText(
        overlay.querySelector("#catSolAdv").value
      ),
    };
  }

  function fillProductExtForm(item) {
    var p = (item && item.product) || {};
    try {
      if ((!p.attrs || !p.attrs.length) && item && item.extra_json) {
        var extra = JSON.parse(String(item.extra_json || "{}"));
        var raw =
          (item.kind === "case" ? extra.case : extra.product) ||
          extra.product ||
          {};
        p = {
          highlight: raw.highlight || "",
          attrs: [],
          applications: raw.applications || [],
        };
        var attrsObj = raw.attrs || {};
        if (attrsObj && typeof attrsObj === "object" && !Array.isArray(attrsObj)) {
          Object.keys(attrsObj).forEach(function (k) {
            p.attrs.push({ label: k, value: String(attrsObj[k]) });
          });
        }
      }
    } catch (e) {}
    var set = function (id, val) {
      var el = overlay.querySelector(id);
      if (el) el.value = val == null ? "" : String(val);
    };
    set("#catProdHighlight", p.highlight || item.highlight || "");
    var attrLines = (p.attrs || item.attrs || [])
      .map(function (a) {
        if (!a || !a.value) return "";
        return (a.label ? a.label + "：" : "") + a.value;
      })
      .filter(Boolean)
      .join("\n");
    set("#catProdAttrs", attrLines);
    set(
      "#catProdRec",
      (p.applications || item.applications || []).join("\n")
    );
  }

  function readProductExtForm() {
    var attrsText = overlay.querySelector("#catProdAttrs").value || "";
    var attrs = [];
    String(attrsText)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .forEach(function (line) {
        var s = String(line || "").trim();
        if (!s) return;
        var sep = s.search(/[:：]/);
        if (sep <= 0) return;
        var label = s.slice(0, sep).trim();
        var value = s.slice(sep + 1).trim();
        if (label && value) attrs.push({ label: label, value: value });
      });
    var attrsObj = {};
    attrs.forEach(function (a) {
      attrsObj[a.label] = a.value;
    });
    return {
      highlight: overlay.querySelector("#catProdHighlight").value.trim(),
      attrs: attrsObj,
      applications: linesFromTextarea(overlay.querySelector("#catProdRec")),
    };
  }

  function fillDescriptionForm(item) {
    var el = overlay.querySelector("#catDescText");
    if (el) el.value = item && item.description != null ? String(item.description) : "";
  }

  function setDrawerTab(tab) {
    var item = findItem(activeItemId);
    var isSolution = item && item.kind === "solution";
    if (tab === "solution") tab = "ext";
    if (tab === "ext" || tab === "description" || tab === "media") {
      drawerMode = tab;
    } else {
      drawerMode = "media";
    }
    var tabs = overlay.querySelector("#catalogAdminDrawerTabs");
    var sol = overlay.querySelector("#catalogAdminSolution");
    var prod = overlay.querySelector("#catalogAdminProductExt");
    var desc = overlay.querySelector("#catalogAdminDescription");
    var mediaWrap = overlay.querySelector("#catalogAdminDrawerMedia");
    if (tabs) {
      tabs.hidden = false;
      tabs.querySelectorAll(".catalog-admin-drawer-tab").forEach(function (btn) {
        btn.classList.toggle(
          "is-active",
          btn.getAttribute("data-tab") === drawerMode
        );
      });
    }
    if (sol) sol.hidden = !(drawerMode === "ext" && isSolution);
    if (prod) prod.hidden = !(drawerMode === "ext" && !isSolution);
    if (desc) desc.hidden = drawerMode !== "description";
    if (mediaWrap) mediaWrap.hidden = drawerMode !== "media";
  }

  function saveSolutionContent() {
    if (!activeItemId) return;
    var item = findItem(activeItemId);
    if (!item) return;
    setStatus(t("保存方案 EXT_JSON…", "Saving solution EXT_JSON…"));
    api("PATCH", {
      id: activeItemId,
      kind: "solution",
      solution: readSolutionForm(),
    })
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("保存失败", "Save failed"),
            "error"
          );
          return;
        }
        replaceCacheItem(pack.j.item);
        if (gridApi) buildGrid();
        fillSolutionForm(pack.j.item);
        setStatus(t("方案 EXT_JSON 已保存", "Solution EXT_JSON saved"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function saveProductExt() {
    if (!activeItemId) return;
    var item = findItem(activeItemId);
    if (!item) return;
    var kind = item.kind === "case" ? "case" : "product";
    setStatus(t("保存产品 EXT_JSON…", "Saving product EXT_JSON…"));
    api("PATCH", {
      id: activeItemId,
      kind: kind,
      product: readProductExtForm(),
    })
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("保存失败", "Save failed"),
            "error"
          );
          return;
        }
        replaceCacheItem(pack.j.item);
        if (gridApi) buildGrid();
        fillProductExtForm(pack.j.item);
        setStatus(t("产品 EXT_JSON 已保存", "Product EXT_JSON saved"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function saveDescription() {
    if (!activeItemId) return;
    var item = findItem(activeItemId);
    if (!item) return;
    var text = overlay.querySelector("#catDescText");
    setStatus(t("保存说明…", "Saving description…"));
    api("PATCH", {
      id: activeItemId,
      description: text ? text.value : "",
    })
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("保存失败", "Save failed"),
            "error"
          );
          return;
        }
        replaceCacheItem(pack.j.item);
        if (gridApi) buildGrid();
        fillDescriptionForm(pack.j.item);
        setStatus(t("说明已保存", "Description saved"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function getFocusedItemId() {
    if (!gridApi) return "";
    try {
      var focused = gridApi.getFocusedCell && gridApi.getFocusedCell();
      if (focused && focused.rowIndex != null) {
        var node =
          typeof gridApi.getDisplayedRowAtIndex === "function"
            ? gridApi.getDisplayedRowAtIndex(focused.rowIndex)
            : null;
        if (node && node.data && node.data.id) return String(node.data.id);
      }
      var selected =
        typeof gridApi.getSelectedRows === "function"
          ? gridApi.getSelectedRows()
          : [];
      if (selected && selected[0] && selected[0].id) {
        return String(selected[0].id);
      }
    } catch (e) {}
    return "";
  }

  function requireSelectedRow(actionLabel) {
    var id = getFocusedItemId() || activeItemId;
    if (!id) {
      setStatus(
        t(
          "请先选中表格中的一行，再点「" + actionLabel + "」",
          "Select a row first, then click " + actionLabel
        ),
        "error"
      );
      return "";
    }
    if (!findItem(id)) {
      setStatus(t("未找到该行", "Row not found"), "error");
      return "";
    }
    return id;
  }

  function editExtJson() {
    var id = requireSelectedRow("EXT_JSON");
    if (!id) return;
    openDrawer(id, "ext");
  }

  function editDescription() {
    var id = requireSelectedRow(t("说明", "Description"));
    if (!id) return;
    openDrawer(id, "description");
  }

  function openDrawer(id, mode) {
    var item = findItem(id);
    if (!item) return;
    activeItemId = id;
    drawerEl.hidden = false;
    var tab =
      mode === "solution"
        ? "ext"
        : mode === "ext" || mode === "description" || mode === "media"
          ? mode
          : "media";
    var isSolution = item.kind === "solution";
    var tabs = overlay.querySelector("#catalogAdminDrawerTabs");
    if (tabs) tabs.hidden = false;

    fillSolutionForm(item);
    fillProductExtForm(item);
    fillDescriptionForm(item);

    var titlePrefix =
      tab === "ext"
        ? "EXT_JSON · "
        : tab === "description"
          ? t("说明 · ", "Description · ")
          : t("媒体 · ", "Media · ");
    overlay.querySelector("#catalogAdminDrawerTitle").textContent =
      titlePrefix + (item.name || id);

    if (tab === "ext") {
      drawerHintEl.textContent = isSolution
        ? t(
            "方案 EXT_JSON：主展区四屏文案。媒体：①缩略图 ②斜切主图 ③简述图/视频。",
            "Solution EXT_JSON: four-screen copy. Media: #1 thumb, #2 diagonal, #3 summary."
          )
        : t(
            "产品 EXT_JSON：特征键值与「推荐用于」。正文请用「说明」按钮编辑。",
            "Product EXT_JSON: attrs + recommended-for. Use Description for feature prose."
          );
    } else if (tab === "description") {
      drawerHintEl.textContent = t(
        "说明可只写正文；键值与推荐用于请放在 EXT_JSON。若说明末尾写「输出：\\n…」也会自动进特征网格。",
        "Description is feature prose; put attrs/recommended-for in EXT_JSON. Trailing key lines in description also feed the attrs grid."
      );
    } else {
      drawerHintEl.textContent = t(
        "焦点在此抽屉时可 Ctrl+V 粘贴图片。",
        "With this drawer open, Ctrl+V pastes images."
      );
    }

    setDrawerTab(tab);
    renderDrawerMedia(item);
    var drop = overlay.querySelector("#catalogAdminDrop");
    if (drop && drawerMode === "media") drop.focus();
  }

  function closeDrawer() {
    activeItemId = null;
    if (drawerEl) drawerEl.hidden = true;
  }

  function renderDrawerMedia(item) {
    if (!drawerStripEl) return;
    drawerStripEl.innerHTML = "";
    var list = (item && item.media) || [];
    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "catalog-admin-strip-empty";
      empty.textContent = t("暂无媒体", "No media yet");
      drawerStripEl.appendChild(empty);
      return;
    }
    list.forEach(function (m, idx) {
      var card = document.createElement("div");
      card.className = "catalog-admin-media-card";
      if (m.media_type === "video") {
        card.innerHTML =
          '<video class="catalog-admin-media-preview" src="' +
          String(m.url || "").replace(/"/g, "&quot;") +
          '" muted playsinline></video>';
      } else {
        card.innerHTML =
          '<img class="catalog-admin-media-preview" src="' +
          String(m.url || "").replace(/"/g, "&quot;") +
          '" alt="" />';
      }
      var ops = document.createElement("div");
      ops.className = "catalog-admin-media-card-ops";
      var orderHint = document.createElement("span");
      orderHint.className = "catalog-admin-media-ord";
      orderHint.textContent =
        idx === 0
          ? t("①缩略图", "#1 thumb")
          : idx === 1
            ? t("②斜切/详情", "#2 diagonal/detail")
            : idx === 2
              ? t("③简述图/视频", "#3 summary")
              : String(idx + 1);
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = t("删", "Del");
      delBtn.addEventListener("click", function () {
        deleteMedia(m.id);
      });
      ops.appendChild(orderHint);
      ops.appendChild(delBtn);
      card.appendChild(ops);
      drawerStripEl.appendChild(card);
    });
  }

  function deleteMedia(mediaId) {
    if (!confirm(t("删除该媒体？", "Delete this media?"))) return;
    api("DELETE", { action: "delete_media", media_id: mediaId })
      .then(function (pack) {
        if (!pack.ok || pack.j.success === false) {
          setStatus(
            (pack.j && pack.j.error) || t("删除失败", "Delete failed"),
            "error"
          );
          return;
        }
        if (pack.j.item) {
          replaceCacheItem(pack.j.item);
          buildGrid();
          renderDrawerMedia(pack.j.item);
        } else {
          load(true);
        }
        setStatus(t("媒体已删除", "Media deleted"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function uploadFiles(fileList) {
    if (!activeItemId) {
      setStatus(t("请先打开某行的媒体抽屉", "Open a row media drawer first"), "error");
      return;
    }
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var chain = Promise.resolve();
    files.forEach(function (file, idx) {
      chain = chain.then(function () {
        setStatus(
          t("上传中 ", "Uploading ") +
            (idx + 1) +
            "/" +
            files.length +
            "…",
          ""
        );
        var fd = new FormData();
        fd.append("phone", currentPhone());
        fd.append("item_id", activeItemId);
        fd.append("file", file, file.name || "upload.bin");
        return api("POST", fd).then(function (pack) {
          if (!pack.ok || !pack.j.item) {
            throw new Error(
              (pack.j && pack.j.error) || t("上传失败", "Upload failed")
            );
          }
          replaceCacheItem(pack.j.item);
          buildGrid();
          renderDrawerMedia(pack.j.item);
        });
      });
    });
    chain
      .then(function () {
        setStatus(t("上传完成", "Upload done"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function open() {
    ensureUi();
    overlay.hidden = false;
    load(true);
  }

  function close() {
    closeDrawer();
    if (overlay) overlay.hidden = true;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var menuBtn = document.getElementById("topNavCatalogAdmin");
    if (menuBtn) {
      menuBtn.addEventListener("click", function () {
        if (!currentPhone()) {
          alert(t("请先登录", "Please log in first"));
          return;
        }
        open();
        var opsMenu = document.getElementById("ops-menu");
        if (opsMenu) opsMenu.classList.remove("open");
      });
    }
  });

  window.openCatalogAdmin = open;
  window.closeCatalogAdmin = close;
})();
