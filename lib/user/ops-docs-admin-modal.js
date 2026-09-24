/**
 * 发布栏：上传 / 列表 / 手机阅读(PDF) / 下载 / 发布人删除
 * 入口：系统运维 → 发布栏
 * 权限：超管 | 网站技术员 | 内容审核主管 | 内容审核员（OPS_HERO）
 */
(function () {
  "use strict";

  var overlay = null;
  var statusEl = null;
  var listEl = null;
  var fileInput = null;
  var titleInput = null;

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
    if (typeof window.userIsOpsFull === "function") {
      return window.userIsOpsFull();
    }
    return false;
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

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return "—";
    function pad(x) {
      return x < 10 ? "0" + x : String(x);
    }
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function fileUrl(id, disposition) {
    var qs =
      "phone=" +
      encodeURIComponent(currentPhone()) +
      "&id=" +
      encodeURIComponent(id);
    if (disposition) qs += "&disposition=" + encodeURIComponent(disposition);
    return "/api/ops-docs-file?" + qs;
  }

  function canDeleteItem(item) {
    if (!item) return false;
    if (isOpsFull()) return true;
    return String(item.publisher_phone || "") === String(currentPhone());
  }

  function isPdfLike(item) {
    var ct = String((item && item.content_type) || "").toLowerCase();
    var name = String((item && item.original_name) || "").toLowerCase();
    return ct.indexOf("pdf") >= 0 || /\.pdf$/.test(name);
  }

  function isTextLike(item) {
    var ct = String((item && item.content_type) || "").toLowerCase();
    var name = String((item && item.original_name) || "").toLowerCase();
    if (ct.indexOf("text/") === 0) return true;
    return /\.(txt|md|csv)$/.test(name);
  }

  function ensureUi() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "catalog-admin-overlay";
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
      t("标题（可空，默认用文件名）", "Title (optional)") +
      '" />' +
      '<input type="file" id="opsDocsFileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.rtf,.odt,.ods,.odp,application/pdf" hidden />' +
      '<button type="button" class="catalog-admin-btn" id="opsDocsPickBtn">' +
      t("选择文件并上传", "Choose & upload") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="opsDocsReload">' +
      t("刷新", "Reload") +
      "</button>" +
      "</div>" +
      '<div id="opsDocsAdminList" class="catalog-admin-qa-list ops-docs-admin-list"></div>' +
      '<p class="catalog-admin-status" id="opsDocsAdminStatus" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(overlay);

    statusEl = overlay.querySelector("#opsDocsAdminStatus");
    listEl = overlay.querySelector("#opsDocsAdminList");
    fileInput = overlay.querySelector("#opsDocsFileInput");
    titleInput = overlay.querySelector("#opsDocsTitleInput");

    overlay.querySelector("#opsDocsAdminHint").textContent = t(
      "PDF/文本可在手机直接阅读；Word/Excel 建议下载后用本地 App。删除：发布人或超管/技术员。",
      "PDF/text open on phone; Office files: download. Delete: publisher or admin/tech."
    );

    overlay.querySelector("#opsDocsAdminClose").addEventListener("click", close);
    overlay.querySelector("#opsDocsReload").addEventListener("click", loadList);
    overlay.querySelector("#opsDocsPickBtn").addEventListener("click", function () {
      if (fileInput) fileInput.click();
    });
    if (fileInput) {
      fileInput.addEventListener("change", onFilePicked);
    }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    listEl.addEventListener("click", onListClick);
    return overlay;
  }

  function onFilePicked() {
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    var phone = currentPhone();
    if (!phone) {
      setStatus(t("请先登录", "Please sign in"), "error");
      return;
    }
    var fd = new FormData();
    fd.append("phone", phone);
    fd.append("file", file, file.name);
    var title = titleInput ? String(titleInput.value || "").trim() : "";
    if (title) fd.append("title", title);

    setStatus(t("上传中…", "Uploading…"), "");
    fetch("/api/ops-docs", {
      method: "POST",
      body: fd,
      cache: "no-store",
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (res) {
        fileInput.value = "";
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
        fileInput.value = "";
        setStatus(t("网络错误", "Network error"), "error");
      });
  }

  function onListClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    if (!id) return;
    if (act === "read") {
      window.open(fileUrl(id, "inline"), "_blank", "noopener");
      return;
    }
    if (act === "download") {
      window.open(fileUrl(id, "attachment"), "_blank", "noopener");
      return;
    }
    if (act === "delete") {
      if (!confirm(t("确认删除该文档？", "Delete this document?"))) return;
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
  }

  function renderList(items) {
    if (!listEl) return;
    if (!items || !items.length) {
      listEl.innerHTML =
        '<p class="ops-docs-empty">' +
        t("暂无文档", "No documents yet") +
        "</p>";
      return;
    }
    var html = items
      .map(function (it) {
        var canRead = isPdfLike(it) || isTextLike(it);
        var del =
          canDeleteItem(it)
            ? '<button type="button" class="catalog-admin-btn catalog-admin-btn--danger" data-act="delete" data-id="' +
              escHtml(it.id) +
              '">' +
              t("删除", "Delete") +
              "</button>"
            : "";
        var readBtn = canRead
          ? '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" data-act="read" data-id="' +
            escHtml(it.id) +
            '">' +
            t("阅读", "Read") +
            "</button>"
          : "";
        return (
          '<article class="ops-docs-row" data-id="' +
          escHtml(it.id) +
          '">' +
          '<div class="ops-docs-row-main">' +
          '<div class="ops-docs-title">' +
          escHtml(it.title || it.original_name) +
          "</div>" +
          '<div class="ops-docs-meta">' +
          escHtml(it.original_name || "") +
          " · " +
          formatBytes(it.size_bytes) +
          " · " +
          escHtml(it.publisher_name || it.publisher_phone || "") +
          " · " +
          formatTime(it.created_at) +
          "</div>" +
          "</div>" +
          '<div class="ops-docs-row-actions">' +
          readBtn +
          '<button type="button" class="catalog-admin-btn" data-act="download" data-id="' +
          escHtml(it.id) +
          '">' +
          t("下载", "Download") +
          "</button>" +
          del +
          "</div>" +
          "</article>"
        );
      })
      .join("");
    listEl.innerHTML = html;
  }

  function loadList() {
    var phone = currentPhone();
    if (!phone) {
      setStatus(t("请先登录", "Please sign in"), "error");
      return;
    }
    setStatus(t("加载中…", "Loading…"), "");
    fetch(
      "/api/ops-docs?phone=" + encodeURIComponent(phone),
      { cache: "no-store" }
    )
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
        renderList(res.j.items || []);
        setStatus("", "");
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
    loadList();
  }

  function close() {
    if (overlay) overlay.hidden = true;
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

  window.openOpsDocsAdmin = open;
  window.closeOpsDocsAdmin = close;
})();
