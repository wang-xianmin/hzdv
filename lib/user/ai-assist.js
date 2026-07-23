/**
 * AI 助手：顶栏入口 → 底部 agent → 紧凑对话窗口（含 Auto / LLM 选择，类似 Cursor）
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "hzdv_ai_assist_model";

  var PROMPTS_ZH = [
    "AI助手能为我做什么？",
    "AI助手能带来什么结果？",
    "AI助手能与我的系统集成吗？",
  ];
  var PROMPTS_EN = [
    "What can the AI assistant do for me?",
    "What results can it bring?",
    "Can it integrate with my systems?",
  ];

  /** id 会随请求传给后端；Auto 由服务端自行选模 */
  var MODEL_OPTIONS = [
    {
      id: "auto",
      label: "Auto",
      descZh: "按问题自动选择合适模型",
      descEn: "Automatically pick the best model",
    },
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      descZh: "综合能力强，适合一般问答",
      descEn: "Strong all-rounder for general Q&A",
    },
    {
      id: "gpt-4o",
      label: "GPT-4o",
      descZh: "更快响应，适合轻量对话",
      descEn: "Faster responses for light chats",
    },
    {
      id: "claude-sonnet-4",
      label: "Claude Sonnet 4",
      descZh: "长文与推理表现出色",
      descEn: "Strong at long context and reasoning",
    },
    {
      id: "claude-opus-4",
      label: "Claude Opus 4",
      descZh: "更高质量，适合复杂任务",
      descEn: "Higher quality for complex tasks",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      descZh: "多模态与长上下文",
      descEn: "Multimodal with long context",
    },
    {
      id: "deepseek-v3",
      label: "DeepSeek V3",
      descZh: "性价比高，中文友好",
      descEn: "Cost-efficient, strong Chinese support",
    },
  ];

  var root = null;
  var inputEl = null;
  var sendBtn = null;
  var promptsEl = null;
  var threadEl = null;
  var modelWrap = null;
  var modelBtn = null;
  var modelMenu = null;
  var modelLabelEl = null;
  var visible = false;
  var opened = false;
  var messages = [];
  var selectedModelId = "auto";

  function currentLang() {
    if (global.currentLang === "en") return "en";
    var htmlLang = String(document.documentElement.lang || "").toLowerCase();
    if (htmlLang.indexOf("en") === 0) return "en";
    return "zh";
  }

  function t(zh, en) {
    return currentLang() === "en" ? en : zh;
  }

  function findModel(id) {
    for (var i = 0; i < MODEL_OPTIONS.length; i++) {
      if (MODEL_OPTIONS[i].id === id) return MODEL_OPTIONS[i];
    }
    return MODEL_OPTIONS[0];
  }

  function loadSavedModel() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw && findModel(raw)) selectedModelId = raw;
    } catch (e) {}
  }

  function saveModel(id) {
    selectedModelId = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {}
    syncModelUi();
  }

  function ensureDom() {
    if (root) return root;
    loadSavedModel();
    root = document.createElement("div");
    root.className = "ai-assist";
    root.id = "aiAssistRoot";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      '<button type="button" class="ai-assist__close" id="aiAssistClose" aria-label="关闭">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M6 6l12 12M18 6L6 18"/>' +
      "</svg></button>" +
      '<div class="ai-assist__stage" role="dialog" aria-label="AI助手对话">' +
      '<div class="ai-assist__thread" id="aiAssistThread" aria-live="polite"></div>' +
      '<div class="ai-assist__prompts" id="aiAssistPrompts" role="list"></div>' +
      '<form class="ai-assist__composer" id="aiAssistForm" autocomplete="off">' +
      '<input class="ai-assist__input" id="aiAssistInput" type="text" maxlength="2000" />' +
      '<div class="ai-assist__toolbar">' +
      '<div class="ai-assist__model" id="aiAssistModel">' +
      '<button type="button" class="ai-assist__model-btn" id="aiAssistModelBtn" aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="ai-assist__model-dot" aria-hidden="true"></span>' +
      '<span class="ai-assist__model-label" id="aiAssistModelLabel">Auto</span>' +
      '<svg class="ai-assist__model-caret" viewBox="0 0 12 12" aria-hidden="true">' +
      '<path d="M3 4.5L6 8l3-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg></button>" +
      '<div class="ai-assist__model-menu" id="aiAssistModelMenu" role="listbox"></div>' +
      "</div>" +
      '<span class="ai-assist__toolbar-spacer"></span>' +
      '<button type="button" class="ai-assist__icon-btn" id="aiAssistMic" aria-label="语音" title="语音">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="3" width="6" height="11" rx="3"/>' +
      '<path d="M5 11a7 7 0 0 0 14 0"/>' +
      '<path d="M12 18v3"/>' +
      "</svg></button>" +
      '<button type="button" class="ai-assist__icon-btn" id="aiAssistAttach" aria-label="附件" title="附件">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21.4 11.6l-8.5 8.5a5 5 0 0 1-7.1-7.1l9.2-9.2a3.2 3.2 0 0 1 4.5 4.5l-9.2 9.1a1.4 1.4 0 1 1-2-2l8.1-8"/>' +
      "</svg></button>" +
      '<button type="submit" class="ai-assist__send" id="aiAssistSend" aria-label="发送">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 19V5"/>' +
      '<path d="M6 11l6-6 6 6"/>' +
      "</svg></button>" +
      "</div></form>" +
      '<p class="ai-assist__legal" id="aiAssistLegal"></p>' +
      '<button type="button" class="ai-assist__agent" id="aiAssistAgent" aria-label="打开 AI 助手">' +
      '<span class="ai-assist__agent-avatar" aria-hidden="true">' +
      '<svg class="ai-assist__agent-face" viewBox="0 0 48 48">' +
      '<circle cx="24" cy="24" r="22" fill="rgba(255,255,255,0.08)"/>' +
      '<circle cx="17" cy="21" r="3" fill="#fff"/>' +
      '<circle cx="31" cy="21" r="3" fill="#fff"/>' +
      '<path d="M16 30c2.6 3.2 6 4.8 8 4.8s5.4-1.6 8-4.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' +
      "</svg></span>" +
      '<span class="ai-assist__agent-copy">' +
      '<span class="ai-assist__agent-title" id="aiAssistAgentTitle">AI助手</span>' +
      '<span class="ai-assist__agent-hint" id="aiAssistAgentHint"></span>' +
      "</span>" +
      "</button>" +
      "</div>";
    document.body.appendChild(root);

    inputEl = root.querySelector("#aiAssistInput");
    sendBtn = root.querySelector("#aiAssistSend");
    promptsEl = root.querySelector("#aiAssistPrompts");
    threadEl = root.querySelector("#aiAssistThread");
    modelWrap = root.querySelector("#aiAssistModel");
    modelBtn = root.querySelector("#aiAssistModelBtn");
    modelMenu = root.querySelector("#aiAssistModelMenu");
    modelLabelEl = root.querySelector("#aiAssistModelLabel");

    root.querySelector("#aiAssistAgent").addEventListener("click", function (e) {
      e.stopPropagation();
      openChat();
    });
    root.querySelector("#aiAssistClose").addEventListener("click", function (e) {
      e.stopPropagation();
      closeChat();
    });
    root.querySelector("#aiAssistForm").addEventListener("submit", function (e) {
      e.preventDefault();
      submitPrompt(inputEl.value);
    });
    inputEl.addEventListener("input", syncSendState);
    root.querySelector("#aiAssistMic").addEventListener("click", function () {
      appendAssistant(t("语音输入即将接入。", "Voice input coming soon."));
    });
    root.querySelector("#aiAssistAttach").addEventListener("click", function () {
      appendAssistant(t("附件上传即将接入。", "Attachments coming soon."));
    });

    modelBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleModelMenu();
    });
    modelMenu.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    root.addEventListener("click", function (e) {
      e.stopPropagation();
      closeModelMenu();
    });

    document.addEventListener("click", function () {
      closeModelMenu();
    });

    renderCopy();
    renderModelMenu();
    syncModelUi();
    return root;
  }

  function toggleModelMenu() {
    if (!modelWrap) return;
    var open = !modelWrap.classList.contains("is-open");
    modelWrap.classList.toggle("is-open", open);
    modelBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderModelMenu();
  }

  function closeModelMenu() {
    if (!modelWrap) return;
    modelWrap.classList.remove("is-open");
    if (modelBtn) modelBtn.setAttribute("aria-expanded", "false");
  }

  function syncModelUi() {
    var m = findModel(selectedModelId);
    if (modelLabelEl) modelLabelEl.textContent = m.label;
    if (modelBtn) {
      modelBtn.setAttribute("data-mode", m.id === "auto" ? "auto" : "manual");
      modelBtn.title = t("选择模型", "Choose model") + ": " + m.label;
    }
    if (modelMenu) {
      modelMenu.querySelectorAll(".ai-assist__model-item").forEach(function (el) {
        el.classList.toggle("is-active", el.getAttribute("data-id") === selectedModelId);
      });
    }
  }

  function renderModelMenu() {
    if (!modelMenu) return;
    modelMenu.innerHTML = "";
    MODEL_OPTIONS.forEach(function (m) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "ai-assist__model-item" + (m.id === selectedModelId ? " is-active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("data-id", m.id);
      btn.setAttribute("aria-selected", m.id === selectedModelId ? "true" : "false");
      btn.innerHTML =
        '<span class="ai-assist__model-item-name"></span>' +
        '<span class="ai-assist__model-item-desc"></span>';
      btn.querySelector(".ai-assist__model-item-name").textContent = m.label;
      btn.querySelector(".ai-assist__model-item-desc").textContent =
        currentLang() === "en" ? m.descEn : m.descZh;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        saveModel(m.id);
        closeModelMenu();
      });
      modelMenu.appendChild(btn);
    });
  }

  function renderCopy() {
    if (!root) return;
    inputEl.placeholder = t("随便问什么…", "Ask anything…");
    var titleEl = root.querySelector("#aiAssistAgentTitle");
    var hintEl = root.querySelector("#aiAssistAgentHint");
    if (titleEl) titleEl.textContent = t("AI助手", "AI Assistant");
    if (hintEl) {
      hintEl.textContent = t("点我开始对话", "Tap to start chatting");
    }
    root.querySelector("#aiAssistLegal").innerHTML = t(
      '与我们聊天即表示您同意我们的 <a href="#" id="aiAssistPrivacy">隐私政策</a>。',
      'By chatting you agree to our <a href="#" id="aiAssistPrivacy">Privacy Policy</a>.'
    );
    var privacy = root.querySelector("#aiAssistPrivacy");
    if (privacy) {
      privacy.addEventListener("click", function (e) {
        e.preventDefault();
        appendAssistant(t("隐私政策页面即将上线。", "Privacy policy page coming soon."));
      });
    }
    renderPrompts();
    renderModelMenu();
    syncModelUi();
  }

  function renderPrompts() {
    if (!promptsEl) return;
    var list = currentLang() === "en" ? PROMPTS_EN : PROMPTS_ZH;
    promptsEl.innerHTML = "";
    list.forEach(function (text) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-assist__prompt";
      btn.setAttribute("role", "listitem");
      btn.textContent = text;
      btn.addEventListener("click", function () {
        submitPrompt(text);
      });
      promptsEl.appendChild(btn);
    });
  }

  function syncSendState() {
    if (!sendBtn || !inputEl) return;
    var ready = String(inputEl.value || "").trim().length > 0;
    sendBtn.classList.toggle("is-ready", ready);
  }

  function syncChattingClass() {
    if (!root) return;
    root.classList.toggle("is-chatting", messages.length > 0);
  }

  function renderThread() {
    if (!threadEl) return;
    threadEl.innerHTML = "";
    messages.forEach(function (m) {
      var bubble = document.createElement("div");
      bubble.className =
        "ai-assist__bubble ai-assist__bubble--" +
        (m.role === "user" ? "user" : "assistant");
      bubble.textContent = m.text;
      threadEl.appendChild(bubble);
    });
    threadEl.scrollTop = threadEl.scrollHeight;
    syncChattingClass();
  }

  function appendMessage(role, text) {
    messages.push({ role: role, text: String(text || ""), model: selectedModelId });
    renderThread();
  }

  function appendAssistant(text) {
    appendMessage("assistant", text);
  }

  function submitPrompt(text) {
    var q = String(text || "").trim();
    if (!q) return;
    var model = findModel(selectedModelId);
    appendMessage("user", q);
    inputEl.value = "";
    syncSendState();
    setTimeout(function () {
      appendAssistant(
        t(
          "已收到（模型：" + model.label + "）。对话能力即将接入。",
          "Received (model: " + model.label + "). Chat coming soon."
        )
      );
    }, 280);
  }

  function showLauncher() {
    ensureDom();
    renderCopy();
    visible = true;
    opened = false;
    root.classList.add("is-visible");
    root.classList.remove("is-open");
    closeModelMenu();
    syncChattingClass();
    root.setAttribute("aria-hidden", "false");
  }

  function hideAll() {
    if (!root) return;
    visible = false;
    opened = false;
    closeModelMenu();
    root.classList.remove("is-visible", "is-open");
    root.setAttribute("aria-hidden", "true");
  }

  function openChat() {
    ensureDom();
    renderCopy();
    visible = true;
    opened = true;
    root.classList.add("is-visible", "is-open");
    syncChattingClass();
    root.setAttribute("aria-hidden", "false");
    syncSendState();
    setTimeout(function () {
      try {
        inputEl.focus();
      } catch (e) {}
    }, 40);
  }

  function closeChat() {
    if (!visible) return;
    opened = false;
    closeModelMenu();
    root.classList.remove("is-open");
    root.classList.add("is-visible");
  }

  function toggleFromNav() {
    ensureDom();
    if (!visible) {
      showLauncher();
      return;
    }
    hideAll();
  }

  function bindNav() {
    var link = document.getElementById("topNavAiAssist");
    if (!link || link.dataset.aiBound === "1") return;
    link.dataset.aiBound = "1";
    link.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleFromNav();
    });
  }

  function onLangChange() {
    if (root) renderCopy();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (modelWrap && modelWrap.classList.contains("is-open")) {
      closeModelMenu();
      return;
    }
    if (opened) closeChat();
    else if (visible) hideAll();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindNav);
  } else {
    bindNav();
  }

  global.AiAssist = {
    show: showLauncher,
    open: openChat,
    hide: hideAll,
    close: closeChat,
    refreshLang: onLangChange,
    getModel: function () {
      return selectedModelId;
    },
    setModel: function (id) {
      if (findModel(id)) saveModel(id);
    },
    listModels: function () {
      return MODEL_OPTIONS.slice();
    },
  };
})(typeof window !== "undefined" ? window : this);
