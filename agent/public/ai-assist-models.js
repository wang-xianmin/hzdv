/**
 * AI 助手 · 模型库管理
 * 入口：顶栏「系统运维」→「AI 模型库」
 *
 * 第一梯队：Doubao / Qwen（环境变量内置，只读展示 + 试通）
 * 第二/三梯队：KV 可编辑
 *
 * 开发调试阶段：任意已登录用户可打开/编辑（与 OPS_TEMP_OPEN_TO_ANY_LOGIN 一致）。
 * 正式收紧时改为仅超级用户。
 */
(function (global) {
  "use strict";

  var overlay = null;
  var listEl = null;
  var statusEl = null;
  var cache = [];
  var tier1Cache = [];

  function t(zh, en) {
    if (global.currentLang === "en") return en;
    var htmlLang = String(document.documentElement.lang || "").toLowerCase();
    return htmlLang.indexOf("en") === 0 ? en : zh;
  }

  function currentPhone() {
    try {
      if (global.__LENG_USER && global.__LENG_USER.phone) {
        return String(global.__LENG_USER.phone);
      }
      var raw = localStorage.getItem("leng_user");
      if (!raw) return "";
      var u = JSON.parse(raw);
      return String((u && u.phone) || "");
    } catch (e) {
      return "";
    }
  }

  function ensureUi() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "ai-models-overlay";
    overlay.id = "aiModelsOverlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="ai-models-dialog" role="dialog" aria-modal="true" aria-labelledby="aiModelsTitle">' +
      '<div class="ai-models-head">' +
      '<h2 id="aiModelsTitle">模型库</h2>' +
      '<button type="button" class="ai-models-close" id="aiModelsClose" aria-label="关闭">&times;</button>' +
      "</div>" +
      '<p class="ai-models-hint" id="aiModelsHint"></p>' +
      '<div class="ai-models-actions">' +
      '<button type="button" class="ai-models-btn" id="aiModelsAdd2">+ 第二梯队</button>' +
      '<button type="button" class="ai-models-btn" id="aiModelsAdd3">+ 第三梯队</button>' +
      '<button type="button" class="ai-models-btn ai-models-btn--ghost" id="aiModelsReload">刷新</button>' +
      '<button type="button" class="ai-models-btn ai-models-btn--ghost" id="aiModelsResetSeed">重置默认种子</button>' +
      "</div>" +
      '<div class="ai-models-list" id="aiModelsList"></div>' +
      '<p class="ai-models-status" id="aiModelsStatus" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(overlay);

    listEl = overlay.querySelector("#aiModelsList");
    statusEl = overlay.querySelector("#aiModelsStatus");

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#aiModelsClose").addEventListener("click", close);
    overlay.querySelector("#aiModelsAdd2").addEventListener("click", function () {
      addBlank(2);
    });
    overlay.querySelector("#aiModelsAdd3").addEventListener("click", function () {
      addBlank(3);
    });
    overlay.querySelector("#aiModelsReload").addEventListener("click", function () {
      loadAdmin(true);
    });
    overlay.querySelector("#aiModelsResetSeed").addEventListener("click", function () {
      if (
        !confirm(
          t(
            "将用推荐默认配置覆盖当前模型库（含阿里 MaaS 新 baseUrl）。确定？",
            "Overwrite model library with recommended defaults (incl. new Aliyun baseUrl)?"
          )
        )
      ) {
        return;
      }
      setStatus(t("重置中…", "Resetting…"));
      api("POST", { action: "reset_seed" })
        .then(function (x) {
          if (!x.ok || !x.data || !x.data.success) {
            setStatus((x.data && x.data.error) || "reset failed", true);
            return;
          }
          cache = x.data.models || [];
          render();
          setStatus(t("已重置为默认种子，可逐一点「试通」", "Reset done — ping each model"));
        })
        .catch(function (err) {
          setStatus(String((err && err.message) || err), true);
        });
    });
    return overlay;
  }

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("is-error", !!isErr);
  }

  function api(method, body) {
    var phone = currentPhone();
    var url = "/api/llm-models";
    if (method === "GET") {
      url += "?admin=1&phone=" + encodeURIComponent(phone);
      return fetch(url, { cache: "no-store" }).then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, status: r.status, data: j };
        });
      });
    }
    return fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(Object.assign({ phone: phone }, body || {})),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, status: r.status, data: j };
      });
    });
  }

  function capsLabel(caps) {
    var c = caps || {};
    var bits = [];
    if (c.vision) bits.push(t("视觉", "Vision"));
    if (c.video) bits.push(t("视频", "Video"));
    if (c.ocr) bits.push("OCR");
    if (!bits.length) bits.push(t("文本", "Text"));
    return bits.join(" · ");
  }

  function renderTier1() {
    var section = document.createElement("section");
    section.className = "ai-models-tier ai-models-tier--t1";
    var title = document.createElement("h3");
    title.textContent = t(
      "第一梯队（前锋 · 菜单语言定主备）",
      "Tier 1 (Front · menu language picks primary)"
    );
    section.appendChild(title);

    var note = document.createElement("p");
    note.className = "ai-models-empty";
    note.textContent = t(
      "由 Cloudflare 环境变量配置，不可在此改 Key；中文菜单 Doubao 首选，英文菜单 Qwen 首选。",
      "Configured via Cloudflare env vars (keys not editable here). ZH menu → Doubao primary; EN → Qwen."
    );
    section.appendChild(note);

    var list = tier1Cache && tier1Cache.length ? tier1Cache : [];
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "ai-models-empty";
      empty.textContent = t("未返回第一梯队状态", "No tier-1 status returned");
      section.appendChild(empty);
      listEl.appendChild(section);
      return;
    }

    list.forEach(function (m, idx) {
      var card = document.createElement("article");
      card.className =
        "ai-models-card ai-models-card--builtin" + (m.ready ? "" : " is-missing");
      var statusText = m.ready
        ? t("已就绪", "Ready")
        : t("缺配置：", "Missing: ") + ((m.missing || []).join(", ") || "?");
      var roleNote = t(m.notes || "", m.notesEn || "");
      card.innerHTML =
        '<div class="ai-models-card-top">' +
        '<span class="ai-models-order">T1.' +
        (idx + 1) +
        "</span>" +
        '<span class="ai-models-input ai-models-input--label ai-models-readonly">' +
        escapeHtml(m.label || "") +
        "</span>" +
        '<span class="ai-models-ready-badge">' +
        escapeHtml(statusText) +
        "</span></div>" +
        '<p class="ai-models-builtin-note">' +
        escapeHtml(roleNote) +
        "</p>" +
        '<label class="ai-models-field">Model ID' +
        '<input class="ai-models-input" readonly value="' +
        escapeAttr(m.modelId || "") +
        '" /></label>' +
        '<label class="ai-models-field">Base URL' +
        '<input class="ai-models-input" readonly value="' +
        escapeAttr(m.baseUrl || "") +
        '" /></label>' +
        '<label class="ai-models-field">' +
        t("密钥环境变量", "API key env") +
        '<input class="ai-models-input" readonly value="' +
        escapeAttr(m.apiKeyEnv || "") +
        '" /></label>' +
        '<div class="ai-models-card-foot">' +
        '<span class="ai-models-caps-preview">' +
        t("文本 · 内置", "Text · builtin") +
        "</span>" +
        '<div class="ai-models-card-actions">' +
        '<button type="button" class="ai-models-btn ai-models-btn--ghost" data-act="ping-builtin">' +
        t("试通", "Ping") +
        "</button></div></div>";

      card.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.getAttribute("data-act") === "ping-builtin") {
          pingBuiltin(m.builtin || (m.role === "doubao" ? "doubao-lite" : "siliconflow-lite"));
        }
      });
      section.appendChild(card);
    });

    listEl.appendChild(section);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function render() {
    if (!listEl) return;
    var hint = overlay.querySelector("#aiModelsHint");
    if (hint) {
      hint.textContent = t(
        "第一梯队看环境变量；二/三梯队密钥填环境变量名（如 ALIYUN_MAAS_API_KEY），不在此粘贴真实 Key。点「试通」验证连通。",
        "Tier 1 uses env vars; Tier 2/3 use env var names only. Ping to verify connectivity."
      );
    }
    overlay.querySelector("#aiModelsTitle").textContent = t("模型库", "Models");
    overlay.querySelector("#aiModelsAdd2").textContent = t("+ 第二梯队", "+ Tier 2");
    overlay.querySelector("#aiModelsAdd3").textContent = t("+ 第三梯队", "+ Tier 3");
    overlay.querySelector("#aiModelsReload").textContent = t("刷新", "Reload");
    var resetBtn = overlay.querySelector("#aiModelsResetSeed");
    if (resetBtn) resetBtn.textContent = t("重置默认种子", "Reset seed");

    listEl.innerHTML = "";
    renderTier1();

    [2, 3].forEach(function (tier) {
      var section = document.createElement("section");
      section.className = "ai-models-tier";
      var title = document.createElement("h3");
      title.textContent =
        tier === 2
          ? t("第二梯队（主力 · RAG / OCR）", "Tier 2 (Main · RAG / OCR)")
          : t("第三梯队（军师 · 复杂/长上下文）", "Tier 3 (Strategist · complex)");
      section.appendChild(title);

      var peers = cache
        .filter(function (m) {
          return m.tier === tier;
        })
        .sort(function (a, b) {
          return a.order - b.order;
        });

      if (!peers.length) {
        var empty = document.createElement("p");
        empty.className = "ai-models-empty";
        empty.textContent = t("暂无模型，点上方添加", "No models yet");
        section.appendChild(empty);
      }

      peers.forEach(function (m, idx) {
        var card = document.createElement("article");
        card.className = "ai-models-card";
        card.dataset.id = m.id;

        card.innerHTML =
          '<div class="ai-models-card-top">' +
          '<span class="ai-models-order">#' +
          (idx + 1) +
          "</span>" +
          '<input class="ai-models-input ai-models-input--label" data-f="label" />' +
          '<div class="ai-models-order-btns">' +
          '<button type="button" data-act="up" title="上移">↑</button>' +
          '<button type="button" data-act="down" title="下移">↓</button>' +
          '<button type="button" data-act="del" class="is-danger" title="删除">×</button>' +
          "</div></div>" +
          '<label class="ai-models-field">Model ID<input class="ai-models-input" data-f="modelId" /></label>' +
          '<label class="ai-models-field">Base URL<input class="ai-models-input" data-f="baseUrl" /></label>' +
          '<label class="ai-models-field">' +
          t("密钥环境变量", "API key env") +
          '<input class="ai-models-input" data-f="apiKeyEnv" placeholder="SILICONFLOW_API_KEY" /></label>' +
          '<div class="ai-models-caps">' +
          '<label><input type="checkbox" data-c="vision" /> ' +
          t("视觉", "Vision") +
          "</label>" +
          '<label><input type="checkbox" data-c="video" /> ' +
          t("视频", "Video") +
          "</label>" +
          '<label><input type="checkbox" data-c="ocr" /> OCR</label>' +
          '<label><input type="checkbox" data-c="enabled" /> ' +
          t("启用", "On") +
          "</label>" +
          "</div>" +
          '<div class="ai-models-card-foot">' +
          '<span class="ai-models-caps-preview"></span>' +
          '<div class="ai-models-card-actions">' +
          '<button type="button" class="ai-models-btn ai-models-btn--ghost" data-act="ping">' +
          t("试通", "Ping") +
          "</button>" +
          '<button type="button" class="ai-models-btn" data-act="save">' +
          t("保存", "Save") +
          "</button></div></div>";

        card.querySelector('[data-f="label"]').value = m.label || "";
        card.querySelector('[data-f="modelId"]').value = m.modelId || "";
        card.querySelector('[data-f="baseUrl"]').value = m.baseUrl || "";
        card.querySelector('[data-f="apiKeyEnv"]').value = m.apiKeyEnv || "";
        card.querySelector('[data-c="vision"]').checked = !!(m.caps && m.caps.vision);
        card.querySelector('[data-c="video"]').checked = !!(m.caps && m.caps.video);
        card.querySelector('[data-c="ocr"]').checked = !!(m.caps && m.caps.ocr);
        card.querySelector('[data-c="enabled"]').checked = m.enabled !== false;
        card.querySelector(".ai-models-caps-preview").textContent = capsLabel(m.caps);

        card.addEventListener("click", function (e) {
          var btn = e.target.closest("[data-act]");
          if (!btn) return;
          var act = btn.getAttribute("data-act");
          if (act === "up" || act === "down") move(m.id, act);
          else if (act === "del") remove(m.id);
          else if (act === "save") saveCard(card, m.id);
          else if (act === "ping") pingModel(m.id, card);
        });

        section.appendChild(card);
      });

      listEl.appendChild(section);
    });
  }

  function readCard(card) {
    return {
      label: card.querySelector('[data-f="label"]').value.trim(),
      modelId: card.querySelector('[data-f="modelId"]').value.trim(),
      baseUrl: card.querySelector('[data-f="baseUrl"]').value.trim(),
      apiKeyEnv: card.querySelector('[data-f="apiKeyEnv"]').value.trim(),
      enabled: card.querySelector('[data-c="enabled"]').checked,
      caps: {
        text: true,
        vision: card.querySelector('[data-c="vision"]').checked,
        video: card.querySelector('[data-c="video"]').checked,
        ocr: card.querySelector('[data-c="ocr"]').checked,
      },
    };
  }

  function pingPayload(extra) {
    return Object.assign({ phone: currentPhone() }, extra || {});
  }

  function pingModel(id, card) {
    if (!currentPhone()) {
      setStatus(t("请先登录后再试通", "Please log in first"), true);
      return;
    }
    // 试通前先按卡片当前填写值保存，避免 KV 里还是旧 baseUrl
    var patch = readCard(card);
    patch.id = id;
    var existing = cache.find(function (m) {
      return m.id === id;
    });
    if (existing) {
      patch.tier = existing.tier;
      patch.order = existing.order;
    }
    setStatus(t("保存并试通中…", "Saving & pinging…"));
    api("POST", { action: "update", id: id, model: patch })
      .then(function (x) {
        if (!x.ok || !x.data || !x.data.success) {
          setStatus((x.data && x.data.error) || "save failed", true);
          return null;
        }
        cache = x.data.models || cache;
        return fetch("/api/llm-ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(pingPayload({ id: id })),
        }).then(function (r) {
          return r.json().then(function (j) {
            return { http: r.status, j: j };
          });
        });
      })
      .then(function (pack) {
        if (!pack) return;
        showPingResult(pack.j);
        render();
      })
      .catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
  }

  function pingBuiltin(name) {
    if (!currentPhone()) {
      setStatus(t("请先登录后再试通", "Please log in first"), true);
      return;
    }
    setStatus(t("试通中…", "Pinging…") + " " + name);
    fetch("/api/llm-ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(pingPayload({ builtin: name })),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { http: r.status, j: j };
        });
      })
      .then(function (pack) {
        showPingResult(pack.j);
      })
      .catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
  }

  function showPingResult(j) {
    if (!j) {
      setStatus("empty response", true);
      return;
    }
    var label = (j.target && (j.target.label || j.target.modelId)) || "";
    if (j.success) {
      setStatus(
        "✓ " +
          label +
          "  " +
          (j.latencyMs || 0) +
          "ms  →  " +
          String(j.reply || "").replace(/\s+/g, " ").slice(0, 80)
      );
    } else {
      setStatus(
        "✗ " + label + "  " + (j.error || "failed") + "  (" + (j.latencyMs || 0) + "ms)",
        true
      );
    }
  }

  function saveCard(card, id) {
    if (!currentPhone()) {
      setStatus(t("请先登录后再保存", "Please log in first"), true);
      return;
    }
    var patch = readCard(card);
    patch.id = id;
    var existing = cache.find(function (m) {
      return m.id === id;
    });
    if (existing) {
      patch.tier = existing.tier;
      patch.order = existing.order;
    }
    setStatus(t("保存中…", "Saving…"));
    api("POST", { action: "update", id: id, model: patch }).then(function (x) {
      if (!x.ok || !x.data || !x.data.success) {
        setStatus((x.data && x.data.error) || "save failed", true);
        return;
      }
      cache = x.data.models || [];
      setStatus(t("已保存", "Saved"));
      render();
      notifyChanged();
    });
  }

  function addBlank(tier) {
    if (!currentPhone()) {
      setStatus(t("请先登录后再添加", "Please log in first"), true);
      return;
    }
    setStatus(t("添加中…", "Adding…"));
    api("POST", {
      action: "add",
      model: {
        tier: tier,
        label: tier === 2 ? "新主力模型" : "新军师模型",
        modelId: "model-id",
        baseUrl: "https://api.example.com/v1",
        apiKeyEnv: "",
        caps: { text: true, vision: false, video: tier === 3, ocr: false },
      },
    }).then(function (x) {
      if (!x.ok || !x.data || !x.data.success) {
        setStatus((x.data && x.data.error) || "add failed", true);
        return;
      }
      cache = x.data.models || [];
      setStatus(t("已添加，请改成真实配置后点保存", "Added — edit then Save"));
      render();
      notifyChanged();
    });
  }

  function move(id, direction) {
    if (!currentPhone()) {
      setStatus(t("请先登录", "Please log in"), true);
      return;
    }
    api("POST", { action: "move", id: id, direction: direction }).then(function (x) {
      if (!x.ok || !x.data || !x.data.success) {
        setStatus((x.data && x.data.error) || "move failed", true);
        return;
      }
      cache = x.data.models || [];
      render();
      notifyChanged();
    });
  }

  function remove(id) {
    if (!currentPhone()) {
      setStatus(t("请先登录", "Please log in"), true);
      return;
    }
    if (!confirm(t("确定删除该模型？", "Delete this model?"))) return;
    api("POST", { action: "delete", id: id }).then(function (x) {
      if (!x.ok || !x.data || !x.data.success) {
        setStatus((x.data && x.data.error) || "delete failed", true);
        return;
      }
      cache = x.data.models || [];
      setStatus(t("已删除", "Deleted"));
      render();
      notifyChanged();
    });
  }

  function loadAdmin(force) {
    ensureUi();
    if (!currentPhone()) {
      setStatus(t("登录后可编辑；仍可查看只读列表", "Log in to edit"), true);
    }
    setStatus(t("加载中…", "Loading…"));
    var phone = currentPhone();
    var url = phone
      ? "/api/llm-models?admin=1&phone=" + encodeURIComponent(phone)
      : "/api/llm-models";
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, data: j };
        });
      })
      .then(function (x) {
        if (!x.ok || !x.data || !x.data.success) {
          setStatus((x.data && x.data.error) || "load failed", true);
          return;
        }
        cache = x.data.models || [];
        tier1Cache = x.data.tier1 || [];
        var readyN = tier1Cache.filter(function (m) {
          return m.ready;
        }).length;
        setStatus(
          t("第一梯队 ", "Tier1 ") +
            readyN +
            "/" +
            Math.max(tier1Cache.length, 2) +
            t(" 就绪 · 二/三梯队 ", " ready · Tier2/3 ") +
            cache.length +
            t(" 个", "") +
            (x.data.seeded ? t("（已写入默认种子）", " (seeded)") : "")
        );
        render();
        if (force) notifyChanged();
      })
      .catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
  }

  function notifyChanged() {
    try {
      if (global.AiAssist && typeof global.AiAssist.reloadModels === "function") {
        global.AiAssist.reloadModels();
      }
    } catch (e) {}
    try {
      global.dispatchEvent(new CustomEvent("hzdv-llm-models-changed"));
    } catch (e2) {}
  }

  function open() {
    ensureUi();
    overlay.hidden = false;
    document.body.classList.add("ai-models-open");
    loadAdmin(false);
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("ai-models-open");
  }

  /** 公开列表，供 agent 下拉 */
  function fetchPickerModels() {
    return fetch("/api/llm-models", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.success) return [];
        return j.models || [];
      })
      .catch(function () {
        return [];
      });
  }

  global.AiAssistModels = {
    open: open,
    close: close,
    fetchPickerModels: fetchPickerModels,
  };

  function bindOpsMenuEntry() {
    var menuBtn = document.getElementById("topNavAiModels");
    if (!menuBtn || menuBtn.dataset.aiModelsBound === "1") return;
    menuBtn.dataset.aiModelsBound = "1";
    menuBtn.addEventListener("click", function () {
      if (localStorage.getItem("leng_logged_in") !== "1") {
        alert(
          t("请先登录后再打开 AI 模型库", "Please log in to open AI Models")
        );
        return;
      }
      // 开发期：任意登录用户可调试；正式改为仅超管
      open();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindOpsMenuEntry);
  } else {
    bindOpsMenuEntry();
  }
})(typeof window !== "undefined" ? window : this);
