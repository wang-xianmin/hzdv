/**
 * AI 助手：顶栏入口 → 底部 agent → 点击后出现预对话引导（建议问题 + 输入条）
 */
(function (global) {
  "use strict";

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

  var root = null;
  var inputEl = null;
  var sendBtn = null;
  var promptsEl = null;
  var visible = false;
  var opened = false;

  function currentLang() {
    if (global.currentLang === "en") return "en";
    var htmlLang = String(document.documentElement.lang || "").toLowerCase();
    if (htmlLang.indexOf("en") === 0) return "en";
    return "zh";
  }

  function t(zh, en) {
    return currentLang() === "en" ? en : zh;
  }

  function ensureDom() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "ai-assist";
    root.id = "aiAssistRoot";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      '<button type="button" class="ai-assist__close" id="aiAssistClose" aria-label="关闭">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M6 6l12 12M18 6L6 18"/>' +
      "</svg></button>" +
      '<div class="ai-assist__stage">' +
      '<div class="ai-assist__prompts" id="aiAssistPrompts" role="list"></div>' +
      '<form class="ai-assist__composer" id="aiAssistForm" autocomplete="off">' +
      '<input class="ai-assist__input" id="aiAssistInput" type="text" maxlength="2000" />' +
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
      "</form>" +
      '<p class="ai-assist__legal" id="aiAssistLegal"></p>' +
      '<button type="button" class="ai-assist__agent" id="aiAssistAgent" aria-label="打开 AI 助手">' +
      '<svg class="ai-assist__agent-face" viewBox="0 0 48 48" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="22" fill="rgba(255,255,255,0.08)"/>' +
      '<circle cx="17" cy="21" r="3" fill="#fff"/>' +
      '<circle cx="31" cy="21" r="3" fill="#fff"/>' +
      '<path d="M16 30c2.6 3.2 6 4.8 8 4.8s5.4-1.6 8-4.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' +
      "</svg></button>" +
      "</div>";
    document.body.appendChild(root);

    inputEl = root.querySelector("#aiAssistInput");
    sendBtn = root.querySelector("#aiAssistSend");
    promptsEl = root.querySelector("#aiAssistPrompts");

    root.querySelector("#aiAssistAgent").addEventListener("click", function (e) {
      e.stopPropagation();
      openPrechat();
    });
    root.querySelector("#aiAssistClose").addEventListener("click", function (e) {
      e.stopPropagation();
      closePrechat();
    });
    root.querySelector("#aiAssistForm").addEventListener("submit", function (e) {
      e.preventDefault();
      submitPrompt(inputEl.value);
    });
    inputEl.addEventListener("input", syncSendState);
    root.querySelector("#aiAssistMic").addEventListener("click", function () {
      setStatus(t("语音输入即将接入", "Voice input coming soon"));
    });
    root.querySelector("#aiAssistAttach").addEventListener("click", function () {
      setStatus(t("附件上传即将接入", "Attachments coming soon"));
    });

    root.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    renderCopy();
    return root;
  }

  function setStatus(msg) {
    if (typeof global.setStatus === "function") {
      try {
        global.setStatus(msg);
        return;
      } catch (e) {}
    }
    if (msg) console.info("[ai-assist]", msg);
  }

  function renderCopy() {
    if (!root) return;
    inputEl.placeholder = t("随便问什么…", "Ask anything…");
    root.querySelector("#aiAssistLegal").innerHTML = t(
      '与我们聊天即表示您同意我们的 <a href="#" id="aiAssistPrivacy">隐私政策</a>。',
      'By chatting you agree to our <a href="#" id="aiAssistPrivacy">Privacy Policy</a>.'
    );
    var privacy = root.querySelector("#aiAssistPrivacy");
    if (privacy) {
      privacy.addEventListener("click", function (e) {
        e.preventDefault();
        setStatus(t("隐私政策页面即将上线", "Privacy policy page coming soon"));
      });
    }
    renderPrompts();
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
        inputEl.value = text;
        syncSendState();
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

  function submitPrompt(text) {
    var q = String(text || "").trim();
    if (!q) return;
    setStatus(t("已收到：「", "Received: “") + q + t("」。对话能力即将接入。", "”. Chat coming soon."));
    inputEl.value = "";
    syncSendState();
  }

  function showLauncher() {
    ensureDom();
    renderCopy();
    visible = true;
    opened = false;
    root.classList.add("is-visible");
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "false");
  }

  function hideAll() {
    if (!root) return;
    visible = false;
    opened = false;
    root.classList.remove("is-visible", "is-open");
    root.setAttribute("aria-hidden", "true");
  }

  function openPrechat() {
    ensureDom();
    renderCopy();
    visible = true;
    opened = true;
    root.classList.add("is-visible", "is-open");
    root.setAttribute("aria-hidden", "false");
    syncSendState();
    setTimeout(function () {
      try {
        inputEl.focus();
      } catch (e) {}
    }, 40);
  }

  function closePrechat() {
    if (!visible) return;
    opened = false;
    root.classList.remove("is-open");
    // 回到底部 agent，方便再次点开
    root.classList.add("is-visible");
  }

  function toggleFromNav() {
    ensureDom();
    if (!visible) {
      showLauncher();
      return;
    }
    if (opened) {
      hideAll();
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
    if (opened) closePrechat();
    else if (visible) hideAll();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindNav);
  } else {
    bindNav();
  }

  global.AiAssist = {
    show: showLauncher,
    open: openPrechat,
    hide: hideAll,
    close: closePrechat,
    refreshLang: onLangChange,
  };
})(typeof window !== "undefined" ? window : this);
