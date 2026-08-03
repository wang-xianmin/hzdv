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
      t("新增", "Add") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminReload">' +
      t("刷新", "Reload") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="catalogAdminSaveRow" disabled>' +
      t("保存当前行", "Save row") +
      "</button>" +
      "</div>" +
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
      '<div class="catalog-admin-drop" id="catalogAdminDrop" tabindex="0">' +
      '<div class="catalog-admin-strip" id="catalogAdminStrip"></div>' +
      '<p class="catalog-admin-drop-tip" id="catalogAdminDropTip"></p>' +
      "</div>" +
      '<div class="catalog-admin-drawer-actions">' +
      '<button type="button" class="catalog-admin-btn" id="catalogAdminPickFile">' +
      t("选择文件", "Choose file") +
      "</button>" +
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
      "文字在表格中编辑；点「媒体」列打开抽屉，可 Ctrl+V 粘贴图片，或拖入/选择图片与视频。",
      "Edit text in the grid. Open the Media column to Ctrl+V paste images, or drag/choose image & video files."
    );
    overlay.querySelector("#catalogAdminDropTip").textContent = t(
      "粘贴图片 · 拖入文件 · 视频请用拖拽或选择文件",
      "Paste images · drop files · use drop/file picker for video"
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
      .querySelector("#catalogAdminSaveRow")
      .addEventListener("click", saveFocusedRow);
    overlay
      .querySelector("#catalogAdminDrawerClose")
      .addEventListener("click", closeDrawer);
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
        headerName: t("类型", "Kind"),
        field: "kind",
        width: 110,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: ["product", "solution"],
        },
        valueFormatter: function (p) {
          return p.value === "solution"
            ? t("方案", "Solution")
            : t("产品", "Product");
        },
      },
      {
        headerName: t("名称", "Name"),
        field: "name",
        flex: 1.2,
        minWidth: 140,
        editable: true,
      },
      {
        headerName: t("型号", "Model"),
        field: "model",
        width: 130,
        editable: true,
      },
      {
        headerName: t("规格", "Specs"),
        field: "specs",
        flex: 1.4,
        minWidth: 160,
        editable: true,
        tooltipField: "specs",
      },
      {
        headerName: t("说明", "Description"),
        field: "description",
        flex: 1.2,
        minWidth: 140,
        editable: true,
        tooltipField: "description",
      },
      {
        headerName: t("排序", "Order"),
        field: "sort_order",
        width: 80,
        editable: true,
      },
      {
        headerName: t("启用", "On"),
        field: "is_active",
        width: 80,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: [1, 0] },
        valueFormatter: function (p) {
          return Number(p.value) ? t("是", "Yes") : t("否", "No");
        },
      },
      {
        headerName: t("媒体", "Media"),
        field: "media",
        width: 120,
        editable: false,
        cellRenderer: function (p) {
          return mediaThumbHtml(p.data || {});
        },
      },
      {
        headerName: t("操作", "Ops"),
        field: "_ops",
        width: 90,
        editable: false,
        cellRenderer: function (p) {
          var id = p.data && p.data.id ? String(p.data.id) : "";
          return (
            '<button type="button" class="catalog-admin-del" data-id="' +
            id.replace(/"/g, "&quot;") +
            '">' +
            t("删除", "Del") +
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
      },
      animateRows: true,
      tooltipShowDelay: 400,
      onCellValueChanged: function () {
        var btn = overlay.querySelector("#catalogAdminSaveRow");
        if (btn) btn.disabled = false;
      },
      onCellClicked: function (ev) {
        var tEl = ev.event && ev.event.target;
        if (!tEl || !tEl.closest) return;
        var mediaBtn = tEl.closest(".catalog-admin-media-btn");
        if (mediaBtn) {
          openDrawer(mediaBtn.getAttribute("data-id"));
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
          t("共 ", "Total ") + cache.length + t(" 条", " items") +
            (force ? "" : ""),
          "ok"
        );
        var btn = overlay.querySelector("#catalogAdminSaveRow");
        if (btn) btn.disabled = true;
        if (activeItemId) {
          var item = findItem(activeItemId);
          if (item) renderDrawerMedia(item);
        }
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
        setStatus(t("已新增，请编辑后点「保存当前行」", "Created — edit then Save row"), "ok");
        if (gridApi) {
          gridApi.setFocusedCell(cache.length - 1, "name");
        }
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function focusedRowData() {
    if (!gridApi) return null;
    var cells = gridApi.getFocusedCell && gridApi.getFocusedCell();
    if (cells && cells.rowIndex != null) {
      var node = gridApi.getDisplayedRowAtIndex(cells.rowIndex);
      if (node && node.data) return node.data;
    }
    var sel = gridApi.getSelectedRows && gridApi.getSelectedRows();
    if (sel && sel[0]) return sel[0];
    return null;
  }

  function saveFocusedRow() {
    var row = focusedRowData();
    if (!row || !row.id) {
      setStatus(t("请先点选一行", "Select a row first"), "error");
      return;
    }
    setStatus(t("保存中…", "Saving…"));
    api("PATCH", {
      id: row.id,
      kind: row.kind,
      name: row.name,
      model: row.model,
      specs: row.specs,
      description: row.description,
      is_active: row.is_active,
      sort_order: row.sort_order,
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
        buildGrid();
        setStatus(t("已保存", "Saved"), "ok");
        var btn = overlay.querySelector("#catalogAdminSaveRow");
        if (btn) btn.disabled = true;
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

  function openDrawer(id) {
    var item = findItem(id);
    if (!item) return;
    activeItemId = id;
    drawerEl.hidden = false;
    overlay.querySelector("#catalogAdminDrawerTitle").textContent =
      t("媒体 · ", "Media · ") + (item.name || id);
    drawerHintEl.textContent = t(
      "焦点在此抽屉时可 Ctrl+V 粘贴图片。",
      "With this drawer open, Ctrl+V pastes images."
    );
    renderDrawerMedia(item);
    var drop = overlay.querySelector("#catalogAdminDrop");
    if (drop) drop.focus();
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
    list.forEach(function (m) {
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
      var coverBtn = document.createElement("button");
      coverBtn.type = "button";
      coverBtn.textContent = t("封面", "Cover");
      coverBtn.addEventListener("click", function () {
        setCover(item.id, m.r2_key);
      });
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = t("删", "Del");
      delBtn.addEventListener("click", function () {
        deleteMedia(m.id);
      });
      ops.appendChild(coverBtn);
      ops.appendChild(delBtn);
      card.appendChild(ops);
      drawerStripEl.appendChild(card);
    });
  }

  function setCover(itemId, r2Key) {
    api("PATCH", { action: "set_cover", id: itemId, r2_key: r2Key })
      .then(function (pack) {
        if (!pack.ok || !pack.j.item) {
          setStatus(
            (pack.j && pack.j.error) || t("设置封面失败", "Set cover failed"),
            "error"
          );
          return;
        }
        replaceCacheItem(pack.j.item);
        buildGrid();
        renderDrawerMedia(pack.j.item);
        setStatus(t("已设为封面", "Cover updated"), "ok");
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
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
