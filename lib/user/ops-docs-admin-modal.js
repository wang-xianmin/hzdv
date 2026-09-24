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
  var pasteBound = false;

  var TRASH_ICON_SVG =
    '<svg class="catalog-admin-trash-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 4h8"/><path d="M10 4V3h4v1"/><path d="M5 7h14"/><path d="M7 7v13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    "</svg>";

  var DOWNLOAD_ICON_SVG =
    '<svg class="ops-docs-dl-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 19h14"/>' +
    "</svg>";

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
      '<button type="button" class="catalog-admin-btn" id="opsDocsAddBtn">' +
      t("新增", "Add") +
      "</button>" +
      '<input type="text" id="opsDocsTitleInput" class="ops-docs-title-input" maxlength="200" placeholder="' +
      t("上传时标题（可空）", "Upload title (optional)") +
      '" />' +
      '<input type="file" id="opsDocsFileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp,.gif,image/*,application/pdf" hidden />' +
      '<input type="file" id="opsDocsImageInput" accept="image/*,.jpg,.jpeg,.png,.webp,.gif" hidden />' +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="opsDocsPickBtn">' +
      t("上传", "Upload") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="opsDocsReload">' +
      t("刷新", "Reload") +
      "</button>" +
      "</div>" +
      '<div id="opsDocsDropHint" class="ops-docs-drop-hint" tabindex="0" role="button" aria-label="paste">' +
      t(
        "点这里再 Ctrl+V 粘贴 PDF/图片（也可拖入）",
        "Click here, then Ctrl+V to paste PDF/image (or drop)"
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
      "粘贴 PDF：先点下面灰色条（或点表格），再 Ctrl+V。不要点在标题输入框里。标题与图片都空时不能再新增。",
      "Paste PDF: click the gray bar (or grid), then Ctrl+V. Not the title box."
    );

    overlay.querySelector("#opsDocsDropHint").textContent = t(
      "点这里再 Ctrl+V 粘贴 PDF/图片（也可拖入）",
      "Click here, then Ctrl+V to paste PDF/image (or drop)"
    );

    var dropHint = overlay.querySelector("#opsDocsDropHint");
    if (dropHint) {
      dropHint.addEventListener("click", function () {
        dropHint.focus();
        setStatus(
          t("已选中粘贴区，请 Ctrl+V", "Paste zone focused — press Ctrl+V"),
          "ok"
        );
      });
    }

    overlay.querySelector("#opsDocsAdminClose").addEventListener("click", close);
    overlay.querySelector("#opsDocsReload").addEventListener("click", loadList);
    overlay.querySelector("#opsDocsAddBtn").addEventListener("click", onAddClick);
    overlay.querySelector("#opsDocsPickBtn").addEventListener("click", function () {
      if (fileInput) fileInput.click();
    });
    if (fileInput) fileInput.addEventListener("change", onFilePicked);
    if (imageInput) imageInput.addEventListener("change", onImagePicked);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    bindDropZone(overlay.querySelector(".ops-docs-admin-dialog"));
    if (gridEl) bindDropZone(gridEl);
    if (dropHint) bindDropZone(dropHint);
    if (!pasteBound) {
      pasteBound = true;
      document.addEventListener("paste", onPaste);
    }
    return overlay;
  }

  function filesFromClipboard(ev) {
    var out = [];
    var items = ev.clipboardData && ev.clipboardData.items;
    var fileList = ev.clipboardData && ev.clipboardData.files;
    if (fileList && fileList.length) {
      for (var f = 0; f < fileList.length; f++) {
        if (fileList[f] && fileList[f].size > 0) out.push(fileList[f]);
      }
      if (out.length) return out;
    }
    if (!items) return out;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== "file") continue;
      var raw = it.getAsFile();
      if (!raw || !(raw.size > 0)) continue;
      if (raw.name && String(raw.name).trim()) {
        out.push(raw);
      } else {
        var mime = String(it.type || raw.type || "application/octet-stream");
        var subtype = mime.split("/")[1] || "bin";
        if (subtype.indexOf("jpeg") >= 0) subtype = "jpg";
        if (subtype.indexOf("pdf") >= 0) subtype = "pdf";
        out.push(
          new File([raw], "paste." + subtype, {
            type: raw.type || it.type || mime,
          })
        );
      }
    }
    return out;
  }

  function isImageFile(file) {
    if (!file) return false;
    var n = String(file.name || "").toLowerCase();
    var ty = String(file.type || "").toLowerCase();
    if (ty.indexOf("image/") === 0) return true;
    return /\.(jpg|jpeg|png|webp|gif|heic|heif)$/.test(n);
  }

  function onPaste(ev) {
    if (!overlay || overlay.hidden) return;
    var active = document.activeElement;
    var inTitle =
      active &&
      (active.id === "opsDocsTitleInput" ||
        (active.classList && active.classList.contains("ops-docs-title-input")));
    var files = filesFromClipboard(ev);
    if (!files.length) {
      if (!inTitle) {
        var hadItems =
          ev.clipboardData &&
          ((ev.clipboardData.files && ev.clipboardData.files.length) ||
            (ev.clipboardData.items && ev.clipboardData.items.length));
        if (hadItems) {
          setStatus(
            t(
              "剪贴板没有可用文件：请先复制 PDF，再点灰色粘贴条后 Ctrl+V",
              "No usable file — copy a PDF, click the gray bar, then Ctrl+V"
            ),
            "error"
          );
        }
      }
      return;
    }
    ev.preventDefault();
    var file = files[0];
    if (!file.size) {
      setStatus(t("空文件，请重新复制后再粘贴", "Empty file — copy again"), "error");
      return;
    }
    var imgPick =
      active && active.closest
        ? active.closest("[data-ops-img-drop]")
        : null;
    if (!imgPick && ev.target && ev.target.closest) {
      imgPick = ev.target.closest("[data-ops-img-drop]");
    }
    if (imgPick && isImageFile(file)) {
      uploadImageForRow(imgPick.getAttribute("data-ops-img-drop"), file);
      return;
    }
    if (pendingImageRowId && isImageFile(file)) {
      uploadImageForRow(pendingImageRowId, file);
      return;
    }
    uploadNewFile(file);
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

  function isIncompleteRow(row) {
    if (!row) return false;
    var raw = row._raw || row;
    var titleEmpty = !String(raw.title || row.title || "").trim();
    var noImage = !String(raw.image_r2_key || row.image_r2_key || "").trim();
    return titleEmpty && noImage;
  }

  function hasIncompleteDraft() {
    for (var i = 0; i < rowCache.length; i++) {
      if (isIncompleteRow(rowCache[i])) return true;
    }
    return false;
  }

  function onAddClick() {
    if (hasIncompleteDraft()) {
      setStatus(
        t(
          "请先填写标题或上传图片后再新增",
          "Fill title or add an image before adding another"
        ),
        "error"
      );
      return;
    }
    var phone = currentPhone();
    if (!phone) {
      setStatus(t("请先登录", "Please sign in"), "error");
      return;
    }
    setStatus(t("新建中…", "Creating…"), "");
    fetch("/api/ops-docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ phone: phone, action: "create_draft" }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.j.success) {
          setStatus(
            (res.j && res.j.error) || t("新建失败", "Create failed"),
            "error"
          );
          return;
        }
        setStatus(t("已新增，请填写标题或上传图片", "Added — fill title or image"), "ok");
        loadList();
      })
      .catch(function () {
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function saveTitle(id, title) {
    return fetch("/api/ops-docs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        phone: currentPhone(),
        id: id,
        title: title,
      }),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j || {} };
      });
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

  function downloadRow(id) {
    if (!id) return;
    var row = null;
    for (var i = 0; i < rowCache.length; i++) {
      if (rowCache[i].id === id) {
        row = rowCache[i];
        break;
      }
    }
    if (!row) return;
    if (hasFile(row)) {
      window.open(fileUrl(id, "attachment", "file"), "_blank", "noopener");
      return;
    }
    if (row.image_r2_key) {
      window.open(fileUrl(id, "attachment", "image"), "_blank", "noopener");
    }
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
    var title = String(p.data.title || "").trim();
    var display = title
      ? escHtml(title)
      : '<span class="ops-docs-title-placeholder">' +
        t("点此填写标题", "Tap to edit title") +
        "</span>";
    var sub = p.data.original_name
      ? '<span class="ops-docs-content-sub">' +
        escHtml(p.data.original_name) +
        "</span>"
      : "";
    var canOpen = hasFile(p.data) || p.data.image_r2_key;
    if (canOpen && title) {
      return (
        '<button type="button" class="ops-docs-content-btn" data-ops-open="' +
        escHtml(p.data.id) +
        '"><span class="ops-docs-content-title">' +
        display +
        "</span>" +
        sub +
        "</button>"
      );
    }
    return (
      '<div class="ops-docs-content-edit"><span class="ops-docs-content-title">' +
      display +
      "</span>" +
      sub +
      "</div>"
    );
  }

  function imageRenderer(p) {
    if (!p.data) return "";
    var id = escHtml(p.data.id);
    var editable = canEditItem(p.data._raw || p.data);
    var img = p.data.image_r2_key
      ? '<img class="catalog-admin-cell-thumb" src="' +
        escHtml(fileUrl(p.data.id, "inline", "image")) +
        '" alt="" />'
      : '<span class="catalog-admin-cell-thumb catalog-admin-cell-thumb--empty">+</span>';
    return (
      '<button type="button" class="catalog-admin-media-btn ops-docs-img-btn' +
      (editable ? "" : " is-readonly") +
      '" data-ops-img-drop="' +
      id +
      '"' +
      (editable ? ' data-ops-img-pick="' + id + '"' : "") +
      ' title="' +
      (editable
        ? t("拖入/粘贴/点选图片", "Drop / paste / tap image")
        : "") +
      '">' +
      img +
      "</button>"
    );
  }

  function opsRenderer(p) {
    if (!p.data) return "";
    var id = escHtml(p.data.id);
    var raw = p.data._raw || p.data;
    var canDl = !!(raw.r2_key || raw.image_r2_key);
    var html = '<div class="ops-docs-ops">';
    if (canDl) {
      html +=
        '<button type="button" class="ops-docs-dl catalog-admin-del" data-ops-dl="' +
        id +
        '" title="' +
        t("下载", "Download") +
        '" aria-label="' +
        t("下载", "Download") +
        '">' +
        DOWNLOAD_ICON_SVG +
        "</button>";
    }
    /* 非本人且非超管/技术员：删除按钮完全不渲染 */
    if (canDeleteItem(raw)) {
      html +=
        '<button type="button" class="catalog-admin-del" data-ops-del="' +
        id +
        '" title="' +
        t("删除", "Delete") +
        '" aria-label="' +
        t("删除", "Delete") +
        '">' +
        TRASH_ICON_SVG +
        "</button>";
    }
    html += "</div>";
    return html;
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
        editable: function (p) {
          return canEditItem((p.data && p.data._raw) || p.data);
        },
        wrapText: true,
        autoHeight: true,
        cellEditor: "agTextCellEditor",
        cellRenderer: contentRenderer,
        cellClass: "ops-docs-cell-content",
        singleClickEdit: true,
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
        headerName: t("操作", "Ops"),
        field: "_ops",
        width: 88,
        minWidth: 72,
        maxWidth: 110,
        sortable: false,
        suppressMovable: true,
        cellRenderer: opsRenderer,
        cellClass: "catalog-admin-cell-ops",
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
      stopEditingWhenCellsLoseFocus: true,
      singleClickEdit: true,
      onCellValueChanged: function (ev) {
        if (!ev || !ev.data || ev.colDef.field !== "title") return;
        var id = ev.data.id;
        var next = String(ev.newValue == null ? "" : ev.newValue).trim();
        var prev = String(ev.oldValue == null ? "" : ev.oldValue).trim();
        if (next === prev) return;
        if (!canEditItem(ev.data._raw || ev.data)) {
          ev.data.title = prev;
          if (gridApi) gridApi.refreshCells({ force: true });
          return;
        }
        saveTitle(id, next).then(function (res) {
          if (!res.ok || !res.j.success) {
            setStatus(
              (res.j && res.j.error) || t("标题保存失败", "Title save failed"),
              "error"
            );
            loadList();
            return;
          }
          if (res.j.item) {
            ev.data.title = res.j.item.title || "";
            ev.data._raw = res.j.item;
            for (var i = 0; i < rowCache.length; i++) {
              if (rowCache[i].id === id) {
                rowCache[i].title = ev.data.title;
                rowCache[i]._raw = res.j.item;
                break;
              }
            }
          }
          setStatus(t("标题已保存", "Title saved"), "ok");
          if (gridApi) gridApi.refreshCells({ force: true });
        });
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
        var dlBtn = tgel.closest ? tgel.closest("[data-ops-dl]") : null;
        if (dlBtn) {
          downloadRow(dlBtn.getAttribute("data-ops-dl"));
          return;
        }
        var pick = tgel.closest ? tgel.closest("[data-ops-img-pick]") : null;
        if (pick && imageInput) {
          pendingImageRowId = pick.getAttribute("data-ops-img-pick") || "";
          imageInput.click();
          return;
        }
        var dropTarget = tgel.closest
          ? tgel.closest("[data-ops-img-drop]")
          : null;
        if (dropTarget) {
          pendingImageRowId =
            dropTarget.getAttribute("data-ops-img-drop") || "";
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
