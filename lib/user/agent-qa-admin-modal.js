/**
 * 企业问答修订（运维）
 * 入口：系统运维 → 企业问答
 * 权鉴与网站背景 / 产品目录相同（超管 | 技术员 | 内容审核岗）
 */
(function () {
  "use strict";

  var overlay = null;
  var statusEl = null;
  var listEl = null;

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
    if (typeof window.userCanSeeOpsAgentQa === "function") {
      return window.userCanSeeOpsAgentQa();
    }
    if (typeof window.userCanSeeOpsCatalog === "function") {
      return window.userCanSeeOpsCatalog();
    }
    if (typeof window.userCanManageHeroBackground === "function") {
      return window.userCanManageHeroBackground();
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

  function qaApi(body) {
    var phone = currentPhone();
    body = body || {};
    body.phone = phone;
    return fetch("/api/agent-qa-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j || {} };
      });
    });
  }

  function ensureUi() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "catalog-admin-overlay";
    overlay.id = "agentQaAdminOverlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="catalog-admin-dialog agent-qa-admin-dialog" role="dialog" aria-modal="true" aria-labelledby="agentQaAdminTitle">' +
      '<div class="catalog-admin-head">' +
      '<h2 id="agentQaAdminTitle">' +
      t("企业问答", "Enterprise Q&A") +
      "</h2>" +
      '<button type="button" class="catalog-admin-close" id="agentQaAdminClose" aria-label="关闭">&times;</button>' +
      "</div>" +
      '<p class="catalog-admin-hint" id="agentQaAdminHint"></p>' +
      '<div class="catalog-admin-actions">' +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="agentQaAdminReload">' +
      t("刷新日志", "Reload logs") +
      "</button>" +
      '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" id="agentQaAdminGold">' +
      t("已发布标准答", "Published gold") +
      "</button>" +
      '<label class="agent-qa-filter">' +
      t("状态", "Status") +
      ' <select id="agentQaStatusFilter">' +
      '<option value="">' +
      t("全部", "All") +
      "</option>" +
      '<option value="pending">pending</option>' +
      '<option value="bad">bad</option>' +
      '<option value="ok">ok</option>' +
      '<option value="published">published</option>' +
      "</select></label>" +
      "</div>" +
      '<div id="agentQaAdminList" class="catalog-admin-qa-list agent-qa-admin-list"></div>' +
      '<p class="catalog-admin-status" id="agentQaAdminStatus" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(overlay);

    statusEl = overlay.querySelector("#agentQaAdminStatus");
    listEl = overlay.querySelector("#agentQaAdminList");
    overlay.querySelector("#agentQaAdminHint").textContent = t(
      "仅企业相关问答。新问题会邮件通知（系统设置「企业问答」邮箱，或 env AGENT_QA_NOTIFY_EMAILS；需 RESEND）。人工改类别/标准答/绑定条目后点「发布回灌」才会写入向量库。",
      "Enterprise Q&A only. New items email notify via system setting or AGENT_QA_NOTIFY_EMAILS (needs RESEND). Publish to vectors only after human correction."
    );
    overlay
      .querySelector("#agentQaAdminClose")
      .addEventListener("click", close);
    overlay
      .querySelector("#agentQaAdminReload")
      .addEventListener("click", function () {
        loadLogs();
      });
    overlay
      .querySelector("#agentQaAdminGold")
      .addEventListener("click", loadGold);
    overlay
      .querySelector("#agentQaStatusFilter")
      .addEventListener("change", function () {
        loadLogs();
      });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    return overlay;
  }

  function loadLogs() {
    ensureUi();
    setStatus(t("加载问答日志…", "Loading Q&A logs…"));
    var phone = currentPhone();
    var status = "";
    var sel = overlay.querySelector("#agentQaStatusFilter");
    if (sel) status = String(sel.value || "");
    var url =
      "/api/agent-qa-review?phone=" +
      encodeURIComponent(phone) +
      "&view=logs&limit=50";
    if (status) url += "&status=" + encodeURIComponent(status);
    fetch(url, { cache: "no-store" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (pack) {
        if (!pack.ok || !pack.j.logs) {
          setStatus(
            (pack.j && pack.j.error) || t("加载失败", "Load failed"),
            "error"
          );
          return;
        }
        renderLogs(pack.j.logs);
        setStatus(
          t("已加载 ", "Loaded ") + pack.j.logs.length + t(" 条", ""),
          "ok"
        );
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function loadGold() {
    ensureUi();
    setStatus(t("加载标准答…", "Loading gold answers…"));
    var phone = currentPhone();
    fetch(
      "/api/agent-qa-review?phone=" +
        encodeURIComponent(phone) +
        "&view=gold&limit=50",
      { cache: "no-store" }
    )
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j || {} };
        });
      })
      .then(function (pack) {
        if (!pack.ok || !pack.j.gold) {
          setStatus(
            (pack.j && pack.j.error) || t("加载失败", "Load failed"),
            "error"
          );
          return;
        }
        renderGold(pack.j.gold);
        setStatus(
          t("已发布 ", "Published ") + pack.j.gold.length + t(" 条", ""),
          "ok"
        );
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "error");
      });
  }

  function renderLogs(logs) {
    if (!listEl) return;
    listEl.innerHTML = "";
    (logs || []).forEach(function (row) {
      var card = document.createElement("div");
      card.className = "catalog-admin-qa-card";
      card.dataset.id = row.id;
      var hits = (row.hits || [])
        .map(function (h) {
          return (h.kind || "") + ":" + (h.name || h.id || "");
        })
        .join(" · ");
      card.innerHTML =
        '<div class="catalog-admin-qa-meta">' +
        escHtml(row.category || "") +
        " · " +
        escHtml(row.answer_mode || "") +
        " · " +
        escHtml(row.review_status || "") +
        (row.published_gold_id
          ? " · gold:" + escHtml(row.published_gold_id.slice(0, 8))
          : "") +
        "</div>" +
        '<div class="catalog-admin-qa-q"><strong>Q</strong> ' +
        escHtml(row.question || "") +
        "</div>" +
        '<div class="catalog-admin-qa-a"><strong>A</strong> ' +
        escHtml((row.reply_text || "").slice(0, 320)) +
        "</div>" +
        (hits
          ? '<div class="catalog-admin-qa-hits">' + escHtml(hits) + "</div>"
          : "") +
        '<label class="catalog-admin-field"><span>' +
        t("纠正类别", "Corrected category") +
        '</span><select data-field="corrected_category">' +
        ["", "product", "solution", "case", "service", "other"]
          .map(function (c) {
            return (
              '<option value="' +
              c +
              '"' +
              ((row.corrected_category || "") === c ? " selected" : "") +
              ">" +
              (c || "—") +
              "</option>"
            );
          })
          .join("") +
        "</select></label>" +
        '<label class="catalog-admin-field"><span>' +
        t("标准答（可空；目录绑定可不填）", "Corrected reply") +
        '</span><textarea data-field="corrected_reply" rows="2">' +
        escHtml(row.corrected_reply || "") +
        "</textarea></label>" +
        '<label class="catalog-admin-field"><span>' +
        t("绑定条目 ID（逗号分隔）", "Bind item IDs (comma)") +
        '</span><input type="text" data-field="corrected_hit_ids" value="' +
        escHtml((row.corrected_hit_ids || []).join(",")) +
        '" /></label>' +
        '<div class="catalog-admin-actions" style="padding-left:0">' +
        '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" data-act="save">' +
        t("保存修订", "Save review") +
        "</button>" +
        '<button type="button" class="catalog-admin-btn" data-act="publish">' +
        t("发布回灌", "Publish") +
        "</button>" +
        "</div>";
      listEl.appendChild(card);
    });

    listEl.onclick = function (ev) {
      var btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      var card = btn.closest(".catalog-admin-qa-card");
      if (!card) return;
      var id = card.dataset.id;
      var cat = card.querySelector('[data-field="corrected_category"]');
      var reply = card.querySelector('[data-field="corrected_reply"]');
      var ids = card.querySelector('[data-field="corrected_hit_ids"]');
      var hitIds = String((ids && ids.value) || "")
        .split(/[,，\s]+/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      var act = btn.getAttribute("data-act");
      var payload = {
        action: act === "publish" ? "publish" : "save",
        id: id,
        review_status: "bad",
        corrected_category: (cat && cat.value) || "",
        corrected_reply: (reply && reply.value) || "",
        corrected_hit_ids: hitIds,
      };
      setStatus(
        payload.action === "publish"
          ? t("发布中…", "Publishing…")
          : t("保存中…", "Saving…")
      );
      qaApi(payload)
        .then(function (pack) {
          if (!pack.ok || pack.j.success === false) {
            setStatus(
              (pack.j && pack.j.error) || t("失败", "Failed"),
              "error"
            );
            return;
          }
          if (pack.j.vector_error) {
            setStatus(
              t("已保存标准答，向量：", "Gold saved; vector: ") +
                pack.j.vector_error,
              "error"
            );
          } else {
            setStatus(
              payload.action === "publish"
                ? t("已发布并回灌向量", "Published to vectors")
                : t("修订已保存", "Review saved"),
              "ok"
            );
          }
          if (payload.action === "publish") loadLogs();
        })
        .catch(function (e) {
          setStatus(String((e && e.message) || e), "error");
        });
    };
  }

  function renderGold(rows) {
    if (!listEl) return;
    listEl.innerHTML = "";
    (rows || []).forEach(function (g) {
      var card = document.createElement("div");
      card.className = "catalog-admin-qa-card";
      card.dataset.goldId = g.id;
      var items = (g.items || [])
        .map(function (it) {
          return (it.kind || "") + ":" + (it.name || it.id || "");
        })
        .join(" · ");
      card.innerHTML =
        '<div class="catalog-admin-qa-meta">' +
        escHtml(g.category || "") +
        " · " +
        escHtml(g.answer_kind || "") +
        (g.is_active ? " · active" : " · inactive") +
        "</div>" +
        '<div class="catalog-admin-qa-q"><strong>Q</strong> ' +
        escHtml(g.question_canonical || "") +
        "</div>" +
        '<div class="catalog-admin-qa-a"><strong>A</strong> ' +
        escHtml((g.reply_text || "").slice(0, 320)) +
        "</div>" +
        (items
          ? '<div class="catalog-admin-qa-hits">' + escHtml(items) + "</div>"
          : "") +
        '<div class="catalog-admin-actions" style="padding-left:0">' +
        '<button type="button" class="catalog-admin-btn catalog-admin-btn--ghost" data-act="unpublish">' +
        t("下架", "Unpublish") +
        "</button>" +
        "</div>";
      listEl.appendChild(card);
    });
    listEl.onclick = function (ev) {
      var btn = ev.target.closest('button[data-act="unpublish"]');
      if (!btn) return;
      var card = btn.closest(".catalog-admin-qa-card");
      if (!card) return;
      var goldId = card.dataset.goldId;
      setStatus(t("下架中…", "Unpublishing…"));
      qaApi({ action: "unpublish", gold_id: goldId })
        .then(function (pack) {
          if (!pack.ok || pack.j.success === false) {
            setStatus(
              (pack.j && pack.j.error) || t("失败", "Failed"),
              "error"
            );
            return;
          }
          setStatus(t("已下架", "Unpublished"), "ok");
          loadGold();
        })
        .catch(function (e) {
          setStatus(String((e && e.message) || e), "error");
        });
    };
  }

  function open() {
    if (!canAccess()) {
      alert(
        t(
          "无权限：需要与网站背景/产品目录相同的运维权限。",
          "No access: same ops permission as Site Background / Product Catalog required."
        )
      );
      return;
    }
    if (!currentPhone()) {
      alert(t("请先登录", "Please log in first"));
      return;
    }
    ensureUi();
    overlay.hidden = false;
    loadLogs();
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var menuBtn = document.getElementById("topNavAgentQa");
    if (menuBtn) {
      menuBtn.addEventListener("click", function () {
        open();
        var opsMenu = document.getElementById("ops-menu");
        if (opsMenu) opsMenu.classList.remove("open");
        var opsToggle = document.getElementById("topNavSystemOps");
        if (opsToggle) opsToggle.setAttribute("aria-expanded", "false");
      });
    }
  });

  window.openAgentQaAdmin = open;
  window.closeAgentQaAdmin = close;
})();
