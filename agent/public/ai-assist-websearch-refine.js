/**
 * 运维：联网检索改写规则（关键词 → 英文 query / 域名）
 * 入口：系统运维 → 联网检索改写
 */
(function (global) {
  "use strict";

  var overlay = null;
  var listEl = null;
  var statusEl = null;
  var rulesCache = [];

  function t(zh, en) {
    try {
      if (global.I18n && typeof global.I18n.t === "function") {
        var k = zh;
        var v = global.I18n.t(k);
        if (v && v !== k) return v;
      }
    } catch (e) {}
    var lang =
      (global.I18n && global.I18n.lang) ||
      document.documentElement.lang ||
      "zh";
    return String(lang).toLowerCase().indexOf("zh") === 0 ? zh : en || zh;
  }

  function phone() {
    try {
      return localStorage.getItem("leng_phone") || "";
    } catch (e) {
      return "";
    }
  }

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color = isErr ? "#b42318" : "";
  }

  function ensureUi() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "ai-models-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="ai-models-sheet" role="dialog" aria-modal="true">' +
      '<header class="ai-models-head">' +
      "<h2>" +
      t("联网检索改写", "Web search refine") +
      "</h2>" +
      '<button type="button" class="ai-models-close" aria-label="close">&times;</button>' +
      "</header>" +
      '<p class="ai-models-hint">' +
      t(
        "匹配用户消息关键词后，改用英文检索式，并可限定域名。排序越靠前越优先。",
        "Match keywords in the user message, rewrite to an English query, optionally lock domains. Earlier rows win."
      ) +
      "</p>" +
      '<div class="ai-models-toolbar">' +
      '<button type="button" class="ai-models-btn" data-act="add">' +
      t("新增", "Add") +
      "</button>" +
      '<button type="button" class="ai-models-btn" data-act="reset">' +
      t("重置种子", "Reset seed") +
      "</button>" +
      '<button type="button" class="ai-models-btn" data-act="reload">' +
      t("刷新", "Reload") +
      "</button>" +
      "</div>" +
      '<div class="ai-models-list" data-role="list"></div>' +
      '<div class="ai-models-status" data-role="status"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    listEl = overlay.querySelector('[data-role="list"]');
    statusEl = overlay.querySelector('[data-role="status"]');
    overlay.querySelector(".ai-models-close").addEventListener("click", close);
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) close();
    });
    overlay.querySelector('[data-act="add"]').addEventListener("click", onAdd);
    overlay.querySelector('[data-act="reset"]').addEventListener("click", onReset);
    overlay.querySelector('[data-act="reload"]').addEventListener("click", function () {
      loadAdmin();
    });
  }

  function api(method, body) {
    var url = "/api/llm-websearch-refine";
    var opts = {
      method: method,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    };
    if (method === "GET") {
      url += "?admin=1&phone=" + encodeURIComponent(phone());
    } else {
      opts.body = JSON.stringify(Object.assign({ phone: phone() }, body || {}));
    }
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j || {} };
      });
    });
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!rulesCache.length) {
      listEl.innerHTML =
        '<p class="ai-models-empty">' +
        t("暂无规则", "No rules yet") +
        "</p>";
      return;
    }
    rulesCache.forEach(function (r, idx) {
      var card = document.createElement("article");
      card.className = "ai-models-card";
      card.innerHTML =
        '<div class="ai-models-card-top">' +
        "<strong>" +
        escapeHtml(r.label || "") +
        "</strong>" +
        '<span class="ai-models-badge">' +
        (r.enabled === false ? "off" : "on") +
        "</span>" +
        "</div>" +
        '<label>Label<input data-f="label" value="' +
        escapeAttr(r.label || "") +
        '"/></label>' +
        '<label>Keywords（逗号分隔）<input data-f="keywords" value="' +
        escapeAttr((r.keywords || []).join(", ")) +
        '"/></label>' +
        '<label>Query（英文检索式）<input data-f="query" value="' +
        escapeAttr(r.query || "") +
        '"/></label>' +
        '<label>Domains（可选，逗号分隔）<input data-f="includeDomains" value="' +
        escapeAttr((r.includeDomains || []).join(", ")) +
        '"/></label>' +
        '<label>timeRange' +
        '<select data-f="timeRange">' +
        option("", r.timeRange, "（无）") +
        option("day", r.timeRange, "day") +
        option("week", r.timeRange, "week") +
        option("month", r.timeRange, "month") +
        option("year", r.timeRange, "year") +
        "</select></label>" +
        '<label class="ai-models-check"><input type="checkbox" data-f="enabled" ' +
        (r.enabled === false ? "" : "checked") +
        "/> enabled</label>" +
        '<div class="ai-models-card-actions">' +
        '<button type="button" data-act="save" data-id="' +
        escapeAttr(r.id) +
        '">' +
        t("保存", "Save") +
        "</button>" +
        '<button type="button" data-act="up" data-id="' +
        escapeAttr(r.id) +
        '"' +
        (idx === 0 ? " disabled" : "") +
        ">↑</button>" +
        '<button type="button" data-act="down" data-id="' +
        escapeAttr(r.id) +
        '"' +
        (idx === rulesCache.length - 1 ? " disabled" : "") +
        ">↓</button>" +
        '<button type="button" data-act="del" data-id="' +
        escapeAttr(r.id) +
        '">' +
        t("删除", "Delete") +
        "</button>" +
        "</div>";
      listEl.appendChild(card);
    });

    listEl.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", onCardAction);
    });
  }

  function option(val, cur, label) {
    return (
      '<option value="' +
      escapeAttr(val) +
      '"' +
      (String(cur || "") === String(val) ? " selected" : "") +
      ">" +
      escapeHtml(label) +
      "</option>"
    );
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function readCard(card) {
    function val(f) {
      var el = card.querySelector('[data-f="' + f + '"]');
      if (!el) return "";
      if (el.type === "checkbox") return !!el.checked;
      return el.value;
    }
    return {
      label: val("label"),
      keywords: val("keywords"),
      query: val("query"),
      includeDomains: val("includeDomains"),
      timeRange: val("timeRange"),
      enabled: val("enabled"),
    };
  }

  function onCardAction(ev) {
    var btn = ev.currentTarget;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    var card = btn.closest(".ai-models-card");
    if (act === "save") {
      var patch = readCard(card);
      setStatus(t("保存中…", "Saving…"));
      api("POST", { action: "update", id: id, rule: patch }).then(function (pack) {
        if (!pack.ok || !pack.j.success) {
          setStatus((pack.j && pack.j.error) || t("保存失败", "Save failed"), true);
          return;
        }
        rulesCache = pack.j.rules || [];
        render();
        setStatus(t("已保存", "Saved"));
      });
      return;
    }
    if (act === "del") {
      if (!confirm(t("确定删除该规则？", "Delete this rule?"))) return;
      api("POST", { action: "delete", id: id }).then(function (pack) {
        if (!pack.ok || !pack.j.success) {
          setStatus((pack.j && pack.j.error) || t("删除失败", "Delete failed"), true);
          return;
        }
        rulesCache = pack.j.rules || [];
        render();
        setStatus(t("已删除", "Deleted"));
      });
      return;
    }
    if (act === "up" || act === "down") {
      api("POST", { action: "move", id: id, direction: act }).then(function (pack) {
        if (!pack.ok || !pack.j.success) {
          setStatus((pack.j && pack.j.error) || t("移动失败", "Move failed"), true);
          return;
        }
        rulesCache = pack.j.rules || [];
        render();
      });
    }
  }

  function onAdd() {
    setStatus(t("新增中…", "Adding…"));
    api("POST", {
      action: "add",
      rule: {
        label: t("新规则", "New rule"),
        keywords: "example",
        query: "example English query",
        includeDomains: "",
        timeRange: "day",
        enabled: true,
      },
    }).then(function (pack) {
      if (!pack.ok || !pack.j.success) {
        setStatus((pack.j && pack.j.error) || t("新增失败", "Add failed"), true);
        return;
      }
      rulesCache = pack.j.rules || [];
      render();
      setStatus(t("已新增", "Added"));
    });
  }

  function onReset() {
    if (
      !confirm(
        t("重置为默认种子规则？当前自定义将被覆盖。", "Reset to seed rules? Custom rules will be overwritten.")
      )
    ) {
      return;
    }
    api("POST", { action: "reset_seed" }).then(function (pack) {
      if (!pack.ok || !pack.j.success) {
        setStatus((pack.j && pack.j.error) || t("重置失败", "Reset failed"), true);
        return;
      }
      rulesCache = pack.j.rules || [];
      render();
      setStatus(t("已重置种子", "Seed restored"));
    });
  }

  function loadAdmin() {
    setStatus(t("加载中…", "Loading…"));
    api("GET").then(function (pack) {
      if (!pack.ok || !pack.j.success) {
        setStatus(
          (pack.j && pack.j.error) || t("加载失败（需运维权限）", "Load failed (ops required)"),
          true
        );
        return;
      }
      rulesCache = pack.j.rules || [];
      render();
      setStatus(
        t("共 ", "Total ") +
          rulesCache.length +
          t(" 条", " rules") +
          (pack.j.seeded ? t("（含刚写入的种子）", " (seed just written)") : "")
      );
    });
  }

  function open() {
    ensureUi();
    overlay.hidden = false;
    document.body.classList.add("ai-models-open");
    loadAdmin();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("ai-models-open");
  }

  global.AiAssistWebsearchRefine = { open: open, close: close };

  function bindOpsMenuEntry() {
    var menuBtn = document.getElementById("topNavWebsearchRefine");
    if (!menuBtn || menuBtn.dataset.webRefineBound === "1") return;
    menuBtn.dataset.webRefineBound = "1";
    menuBtn.addEventListener("click", function () {
      if (localStorage.getItem("leng_logged_in") !== "1") {
        alert(t("请先登录", "Please log in"));
        return;
      }
      open();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindOpsMenuEntry);
  } else {
    bindOpsMenuEntry();
  }
})(typeof window !== "undefined" ? window : this);
