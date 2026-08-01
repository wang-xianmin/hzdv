/**
 * AI 助手 · 模型库管理
 * 入口：顶栏「系统运维」→「AI 模型库」
 *
 * 第一/二/三梯队全部存 KV，可增删改、排序、试通。
 * 密钥只填环境变量名（如 ARK_API_KEY），真实 Key 配在 Cloudflare Pages。
 *
 * 管理入口在「系统运维」→「AI 模型库」，写接口走 assertOpsAccess（超管/技术员）。
 * 对话接口 /api/llm-chat 与运维解耦，任意已注册用户可用。
 */
(function (global) {
  "use strict";

  var overlay = null;
  var listEl = null;
  var statusEl = null;
  var cache = [];

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
        "三个梯队均可编辑排序，同梯队内越靠前越优先。密钥填环境变量名（如 ARK_API_KEY），不在此粘贴真实 Key。点「试通」验证连通。",
        "All three tiers are editable; order within a tier decides priority. Use API key env var names only. Ping to verify."
      );
    }
    overlay.querySelector("#aiModelsTitle").textContent = t("模型库", "Models");
    overlay.querySelector("#aiModelsReload").textContent = t("刷新", "Reload");
    var resetBtn = overlay.querySelector("#aiModelsResetSeed");
    if (resetBtn) resetBtn.textContent = t("重置默认种子", "Reset seed");

    listEl.innerHTML = "";

    [1, 2, 3].forEach(function (tier) {
      var section = document.createElement("section");
      section.className = "ai-models-tier";
      var title = document.createElement("h3");
      title.textContent =
        tier === 1
          ? t("第一梯队（前锋 · 闲聊/快问快答）", "Tier 1 (Front · chit-chat)")
          : tier === 2
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
        empty.textContent = t("暂无模型，点下方「新增模型」", "No models yet — click Add below");
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

      var addWrap = document.createElement("div");
      addWrap.className = "ai-models-tier-add";
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "ai-models-btn ai-models-btn--ghost";
      addBtn.textContent = t("+ 新增模型", "+ Add model");
      addBtn.addEventListener("click", function () {
        addBlank(tier);
      });
      addWrap.appendChild(addBtn);
      section.appendChild(addWrap);

      listEl.appendChild(section);
    });
  }

  function readCard(card) {
    var baseUrl = card.querySelector('[data-f="baseUrl"]').value.trim();
    var apiKeyEnv = card.querySelector('[data-f="apiKeyEnv"]').value.trim();
    // 纠错：密钥栏误贴 URL / 与 Base URL 对调
    if (/^https?:\/\//i.test(apiKeyEnv) || apiKeyEnv.indexOf("://") >= 0) {
      if (!baseUrl || /^[A-Z][A-Z0-9_]*$/.test(baseUrl)) {
        var prev = baseUrl;
        baseUrl = apiKeyEnv.replace(/\/+$/, "");
        apiKeyEnv = /^[A-Z][A-Z0-9_]*$/.test(prev) ? prev : "";
      } else {
        apiKeyEnv = "";
      }
    }
    if (!apiKeyEnv && baseUrl) {
      var u = baseUrl.toLowerCase();
      if (u.indexOf("aliyuncs.com") >= 0 || u.indexOf("dashscope") >= 0) {
        apiKeyEnv = "ALIYUN_MAAS_API_KEY";
      } else if (u.indexOf("siliconflow") >= 0) {
        apiKeyEnv = "SILICONFLOW_API_KEY";
      } else if (u.indexOf("deepseek") >= 0) {
        apiKeyEnv = "DEEPSEEK_API_KEY";
      } else if (u.indexOf("volces.com") >= 0 || u.indexOf("ark.") >= 0) {
        apiKeyEnv = "ARK_API_KEY";
      }
    }
    return {
      label: card.querySelector('[data-f="label"]').value.trim(),
      modelId: card.querySelector('[data-f="modelId"]').value.trim(),
      baseUrl: baseUrl,
      apiKeyEnv: apiKeyEnv,
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
        label: tier === 1 ? "新前锋模型" : tier === 2 ? "新主力模型" : "新军师模型",
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
        var counts = [1, 2, 3].map(function (tier) {
          return cache.filter(function (m) {
            return m.tier === tier;
          }).length;
        });
        setStatus(
          t("一/二/三梯队：", "Tier 1/2/3: ") +
            counts.join(" / ") +
            t(" 个模型", " models") +
            (x.data.migrated
              ? t("（已把原内置第一梯队迁入模型库）", " (built-in tier 1 migrated)")
              : "") +
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
