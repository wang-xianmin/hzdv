/**
 * 发布栏（手机优先 AG Grid）
 * 列：序号 | 时间 | 发布者 | 内容 | 图形(可拖入) | 删
 * 入口：系统运维 → 发布栏
 */
(function () {
  "use strict";

  var overlay = null;
  var statusEl = null;
  var gridEl = null;
  var gridApi = null;
  var fileInput = null;
  var imageInput = null;
  var titleInput = null;
  var pendingImageRowId = "";
  var rowCache = [];

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

  function canAccess() {
    if (typeof window.userCanSeeOpsDocs === "function") {
      return window.userCanSeeOpsDocs();
    }
    if (typeof window.userCanSeeOpsCatalog === "function") {
      return window.userCanSeeOpsCatalog();
    }
    return false;
  }

  function isOpsFull() {
    return typeof window.userIsOpsFull === "function"
      ? !!window.userIsOpsFull()
      : false;
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className =
      "catalog-admin-status" +
      (kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : "");
  }

  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return "—";
    function pad(x) {
      return x < 10 ? "0" + x : String(x);
    }
    return (
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function fileUrl(id, disposition, kind) {
    var qs =
      "phone=" +
      encodeURIComponent(currentPhone()) +
      "&id=" +
      encodeURIComponent(id);
    if (disposition) qs += "&disposition=" + encodeURIComponent(disposition);
    if (kind) qs += "&kind=" + encodeURIComponent(kind);
    return "/api/ops-docs-file?" + qs;
  }

  function canDeleteItem(item) {
    if (!item) return false;
    if (isOpsFull()) return true;
    return String(item.publisher_phone || "") === String(currentPhone());
  }

  function canEditItem(item) {
    return canDeleteItem(item);
  }

  function isPdfLike(item) {
    var ct = String((item && item.content_type) || "").toLowerCase();
    var name = String((item && item.original_name) || "").trim().toLowerCase();
    return ct.indexOf("pdf") >= 0 || /\.pdf$/.test(name);
  }

  function isTextLike(item) {
    var ct = String((item && item.content_type) || "").toLowerCase();
    var name = String((item && item.original_name) || "").toLowerCase();
    if (ct.indexOf("text/") === 0) return true;
    return /\.(txt|md|csv)$/.test(name);
  }

  function hasFile(item) {
    return !!(item && item.r2_key);
  }

  function toRow(item, seq) {
    return {
      id: item.id,
      seq: seq,
      created_at: item.created_at,
      time_label: formatTime(item.created_at),
      publisher:
        item.publisher_name || item.publisher_phone || "—",
      publisher_phone: item.publisher_phone,
      title: item.title || item.original_name || "",
      original_name: item.original_name || "",
      content_type: item.content_type || "",
      r2_key: item.r2_key || "",
      image_r2_key: item.image_r2_key || "",
      size_bytes: item.size_bytes || 0,
      _raw: item,
    };
  }

  function ensureUi() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "catalog-admin-overlay ops-docs-overlay";
    overlay.id = "opsDocsAdminOverlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="catalog-admin-dialog ops-docs-admin-dialog" role="dialog" aria-modal="true" aria-labelledby="opsDocsAdminTitle">' +
      '<div class="catalog-admin-head">' +
      '<h2 id="opsDocsAdminTitle">' +
      t("发布栏", "Bulletin") +
      "</h2>" +
      '<button type="button" class="catalog-admin-close" id="opsDocsAdminClose" aria-label="关闭">&times;</button>' +
      "</div>" +
      '<p class="catalog-admin-hint" id="opsDocsAdminHint"></p>' +
      '<div class="catalog-admin-actions ops-docs-upload-row">' +
      '<input type="text" id="opsDocsTitleInput" class="ops-docs-title-input" maxlength="200" placeholder="' +
      t("内容标题（可空）", "Title (optional)") +
      '" />' +
      '<input type="file" id="opsDocsFileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp,.gif,image/*,application/pdf" hidden />' +
      '<input type="file" id="opsDocsImageInput" accept="image/*,.jpg,.jpeg,.png,.webp,.gif" hidden />' +
      '<button type="button" class="catalog-admin-btn" id="opsDocsPickBtn">' +
      t("上传", "Upload") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="opsDocsReload">' +
      t("刷新", "Reload") +
      "</button>" +
      "</div>" +
      '<div id="opsDocsDropHint" class="ops-docs-drop-hint">' +
      t(
        "可将文件拖入表格；图形格也可直接拖入图片",
        "Drop files onto the grid; drop images onto the graphic cell"
      ) +
      "</div>" +
      '<div id="opsDocsGrid" class="ops-docs-grid ag-theme-quartz" role="grid"></div>' +
      '<p class="catalog-admin-status" id="opsDocsAdminStatus" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(overlay);

    statusEl = overlay.querySelector("#opsDocsAdminStatus");
    gridEl = overlay.querySelector("#opsDocsGrid");
    fileInput = overlay.querySelector("#opsDocsFileInput");
    imageInput = overlay.querySelector("#opsDocsImageInput");
    titleInput = overlay.querySelector("#opsDocsTitleInput");

    overlay.querySelector("#opsDocsAdminHint").textContent = t(
      "手机可直接读 PDF。点内容打开/下载；图形格拖入或点选图片。删除：发布人或超管/技术员。",
      "PDF opens on phone. Tap content to open; drop/tap graphic cell for images. Delete: publisher or admin."
    );

    overlay.querySelector("#opsDocsAdminClose").addEventListener("click", close);
    overlay.querySelector("#opsDocsReload").addEventListener("click", loadList);
    overlay.querySelector("#opsDocsPickBtn").addEventListener("click", function () {
      if (fileInput) fileInput.click();
    });
    if (fileInput) fileInput.addEventListener("change", onFilePicked);
    if (imageInput) imageInput.addEventListener("change", onImagePicked);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    bindDropZone(overlay.querySelector(".ops-docs-admin-dialog"));
    return overlay;
  }

  function bindDropZone(el) {
    if (!el || el.__opsDocsDropBound) return;
    el.__opsDocsDropBound = true;
    el.addEventListener("dragover", function (e) {
      e.preventDefault();
      el.classList.add("is-dragover");
    });
    el.addEventListener("dragleave", function (e) {
      if (e.target === el) el.classList.remove("is-dragover");
    });
    el.addEventListener("drop", function (e) {
      e.preventDefault();
      el.classList.remove("is-dragover");
      var imgCell = e.target && e.target.closest
        ? e.target.closest("[data-ops-img-drop]")
        : null;
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var file = files[0];
      if (imgCell) {
        var rid = imgCell.getAttribute("data-ops-img-drop");
        uploadImageForRow(rid, file);
        return;
      }
      uploadNewFile(file);
    });
  }

  function uploadNewFile(file) {
    var phone = currentPhone();
    if (!phone) {
      setStatus(t("请先登录", "Please sign in"), "error");
      return;
    }
    if (!file) return;
    var fd = new FormData();
    fd.append("phone", phone);
    fd.append("file", file, file.name);
    var title = titleInput ? String(titleInput.value || "").trim() : "";
    if (title) fd.append("title", title);
    setStatus(t("上传中…", "Uploading…"), "");
    fetch("/api/ops-docs", { method: "POST", body: fd, cache: "no-store" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        if (fileInput) fileInput.value = "";
        if (!res.ok || !res.j.success) {
          setStatus(
            (res.j && res.j.error) || t("上传失败", "Upload failed"),
            "error"
          );
          return;
        }
        if (titleInput) titleInput.value = "";
        setStatus(t("上传成功", "Uploaded"), "ok");
        loadList();
      })
      .catch(function () {
        if (fileInput) fileInput.value = "";
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function uploadImageForRow(id, file) {
    if (!id || !file) return;
    var row = null;
    for (var i = 0; i < rowCache.length; i++) {
      if (rowCache[i].id === id) {
        row = rowCache[i];
        break;
      }
    }
    if (row && !canEditItem(row._raw || row)) {
      setStatus(t("无权修改该行图形", "Cannot edit this graphic"), "error");
      return;
    }
    var phone = currentPhone();
    var fd = new FormData();
    fd.append("phone", phone);
    fd.append("id", id);
    fd.append("action", "image");
    fd.append("file", file, file.name);
    setStatus(t("图形上传中…", "Uploading image…"), "");
    fetch("/api/ops-docs", { method: "POST", body: fd, cache: "no-store" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        if (imageInput) imageInput.value = "";
        pendingImageRowId = "";
        if (!res.ok || !res.j.success) {
          setStatus(
            (res.j && res.j.error) || t("图形上传失败", "Image upload failed"),
            "error"
          );
          return;
        }
        setStatus(t("图形已更新", "Graphic updated"), "ok");
        loadList();
      })
      .catch(function () {
        if (imageInput) imageInput.value = "";
        pendingImageRowId = "";
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function onFilePicked() {
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    uploadNewFile(fileInput.files[0]);
  }

  function onImagePicked() {
    if (!imageInput || !imageInput.files || !imageInput.files[0]) return;
    if (!pendingImageRowId) return;
    uploadImageForRow(pendingImageRowId, imageInput.files[0]);
  }

  function deleteRow(id) {
    if (!confirm(t("确认删除？", "Delete?"))) return;
    setStatus(t("删除中…", "Deleting…"), "");
    fetch("/api/ops-docs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ phone: currentPhone(), id: id }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.j.success) {
          setStatus(
            (res.j && res.j.error) || t("删除失败", "Delete failed"),
            "error"
          );
          return;
        }
        setStatus(t("已删除", "Deleted"), "ok");
        loadList();
      })
      .catch(function () {
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function openContent(row) {
    if (!row) return;
    if (hasFile(row)) {
      var disp =
        isPdfLike(row) || isTextLike(row) ? "inline" : "attachment";
      window.open(fileUrl(row.id, disp, "file"), "_blank", "noopener");
      return;
    }
    if (row.image_r2_key) {
      window.open(fileUrl(row.id, "inline", "image"), "_blank", "noopener");
    }
  }

  function contentRenderer(p) {
    if (!p.data) return "";
    var title = escHtml(p.data.title || "—");
    var sub = p.data.original_name
      ? '<span class="ops-docs-content-sub">' +
        escHtml(p.data.original_name) +
        "</span>"
      : "";
    return (
      '<button type="button" class="ops-docs-content-btn" data-ops-open="' +
      escHtml(p.data.id) +
      '"><span class="ops-docs-content-title">' +
      title +
      "</span>" +
      sub +
      "</button>"
    );
  }

  function imageRenderer(p) {
    if (!p.data) return "";
    var id = escHtml(p.data.id);
    var editable = canEditItem(p.data._raw || p.data);
    var inner = "";
    if (p.data.image_r2_key) {
      inner =
        '<img class="ops-docs-thumb" src="' +
        escHtml(fileUrl(p.data.id, "inline", "image")) +
        '" alt="" loading="lazy" />';
    } else {
      inner =
        '<span class="ops-docs-thumb-empty">' +
        (editable ? t("拖入/点选", "Drop/tap") : "—") +
        "</span>";
    }
    return (
      '<div class="ops-docs-thumb-wrap' +
      (editable ? " is-editable" : "") +
      '" data-ops-img-drop="' +
      id +
      '"' +
      (editable ? ' data-ops-img-pick="' + id + '"' : "") +
      ">" +
      inner +
      "</div>"
    );
  }

  function deleteRenderer(p) {
    if (!p.data) return "";
    if (!canDeleteItem(p.data._raw || p.data)) {
      return '<span class="ops-docs-del-disabled">—</span>';
    }
    return (
      '<button type="button" class="ops-docs-del-btn" data-ops-del="' +
      escHtml(p.data.id) +
      '" aria-label="' +
      t("删除", "Delete") +
      '">×</button>'
    );
  }

  function buildGrid(rows) {
    if (!gridEl) return;
    if (typeof agGrid === "undefined" || !agGrid.createGrid) {
      setStatus(t("AG Grid 未加载", "AG Grid missing"), "error");
      return;
    }

    var colDefs = [
      {
        headerName: t("序号", "#"),
        field: "seq",
        width: 56,
        minWidth: 48,
        maxWidth: 64,
        sortable: false,
        suppressMovable: true,
        cellClass: "ops-docs-cell-seq",
      },
      {
        headerName: t("时间", "Time"),
        field: "time_label",
        width: 92,
        minWidth: 84,
        sortable: false,
        cellClass: "ops-docs-cell-time",
      },
      {
        headerName: t("发布者", "By"),
        field: "publisher",
        width: 88,
        minWidth: 72,
        flex: 0.6,
        sortable: false,
        wrapText: true,
        autoHeight: true,
      },
      {
        headerName: t("内容", "Content"),
        field: "title",
        flex: 1.4,
        minWidth: 120,
        sortable: false,
        wrapText: true,
        autoHeight: true,
        cellRenderer: contentRenderer,
        cellClass: "ops-docs-cell-content",
      },
      {
        headerName: t("图形", "Pic"),
        field: "image_r2_key",
        width: 78,
        minWidth: 72,
        maxWidth: 96,
        sortable: false,
        cellRenderer: imageRenderer,
        cellClass: "ops-docs-cell-img",
      },
      {
        headerName: t("删", "Del"),
        field: "id",
        width: 52,
        minWidth: 48,
        maxWidth: 56,
        sortable: false,
        suppressMovable: true,
        cellRenderer: deleteRenderer,
        cellClass: "ops-docs-cell-del",
      },
    ];

    var gridOptions = {
      columnDefs: colDefs,
      rowData: rows,
      rowHeight: 72,
      headerHeight: 36,
      domLayout: "normal",
      animateRows: false,
      suppressCellFocus: true,
      getRowId: function (p) {
        return String((p.data && p.data.id) || "");
      },
      defaultColDef: {
        resizable: true,
        sortable: false,
        filter: false,
      },
      onGridReady: function () {
        try {
          if (gridApi && gridApi.sizeColumnsToFit) gridApi.sizeColumnsToFit();
        } catch (e) {}
      },
      onCellClicked: function (ev) {
        var tgel = ev.event && ev.event.target;
        if (!tgel) return;
        var openBtn = tgel.closest
          ? tgel.closest("[data-ops-open]")
          : null;
        if (openBtn) {
          openContent(ev.data);
          return;
        }
        var delBtn = tgel.closest ? tgel.closest("[data-ops-del]") : null;
        if (delBtn) {
          deleteRow(delBtn.getAttribute("data-ops-del"));
          return;
        }
        var pick = tgel.closest ? tgel.closest("[data-ops-img-pick]") : null;
        if (pick && imageInput) {
          pendingImageRowId = pick.getAttribute("data-ops-img-pick") || "";
          imageInput.click();
        }
      },
    };

    if (gridApi) {
      try {
        gridApi.setGridOption("rowData", rows);
        if (gridApi.sizeColumnsToFit) gridApi.sizeColumnsToFit();
      } catch (e) {
        try {
          gridApi.destroy();
        } catch (e2) {}
        gridApi = null;
        gridEl.innerHTML = "";
        gridApi = agGrid.createGrid(gridEl, gridOptions);
      }
    } else {
      gridEl.innerHTML = "";
      gridApi = agGrid.createGrid(gridEl, gridOptions);
    }
  }

  function loadList() {
    var phone = currentPhone();
    if (!phone) {
      setStatus(t("请先登录", "Please sign in"), "error");
      return;
    }
    setStatus(t("加载中…", "Loading…"), "");
    fetch("/api/ops-docs?phone=" + encodeURIComponent(phone), {
      cache: "no-store",
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.j.success) {
          setStatus(
            (res.j && res.j.error) || t("加载失败", "Load failed"),
            "error"
          );
          return;
        }
        var items = res.j.items || [];
        var rows = items.map(function (it, idx) {
          return toRow(it, idx + 1);
        });
        rowCache = rows;
        buildGrid(rows);
        setStatus(
          rows.length
            ? t("共 ", "Total ") + rows.length + t(" 条", "")
            : t("暂无内容，可上传或拖入文件", "Empty — upload or drop files"),
          ""
        );
        setTimeout(function () {
          try {
            if (gridApi && gridApi.sizeColumnsToFit) gridApi.sizeColumnsToFit();
          } catch (e) {}
        }, 50);
      })
      .catch(function () {
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function open() {
    if (!canAccess()) {
      alert(t("无权限", "No permission"));
      return;
    }
    ensureUi();
    overlay.hidden = false;
    document.body.classList.add("ops-docs-open");
    loadList();
  }

  function close() {
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("ops-docs-open");
  }

  function bindMenu() {
    var menuBtn = document.getElementById("topNavOpsDocs");
    if (!menuBtn || menuBtn.__opsDocsBound) return;
    menuBtn.__opsDocsBound = true;
    menuBtn.addEventListener("click", function (e) {
      e.preventDefault();
      open();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindMenu);
  } else {
    bindMenu();
  }

  window.addEventListener("resize", function () {
    if (!overlay || overlay.hidden || !gridApi) return;
    try {
      if (gridApi.sizeColumnsToFit) gridApi.sizeColumnsToFit();
    } catch (e) {}
  });

  window.openOpsDocsAdmin = open;
  window.closeOpsDocsAdmin = close;
})();
