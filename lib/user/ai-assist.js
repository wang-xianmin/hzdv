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
      '<div class="ai-assist__composer-main">' +
      '<div class="ai-assist__plus" id="aiAssistPlus">' +
      '<button type="button" class="ai-assist__plus-btn" id="aiAssistPlusBtn" aria-haspopup="menu" aria-expanded="false" aria-label="添加">' +
      '<svg class="ai-assist__plus-icon ai-assist__plus-icon--add" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M12 5v14M5 12h14"/>' +
      "</svg>" +
      '<svg class="ai-assist__plus-icon ai-assist__plus-icon--close" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M6 6l12 12M18 6L6 18"/>' +
      "</svg></button>" +
      '<div class="ai-assist__plus-menu" id="aiAssistPlusMenu" role="menu" hidden>' +
      '<button type="button" class="ai-assist__plus-item" id="aiAssistUploadFile" role="menuitem">' +
      '<span class="ai-assist__plus-item-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21.4 11.6l-8.5 8.5a5 5 0 0 1-7.1-7.1l9.2-9.2a3.2 3.2 0 0 1 4.5 4.5l-9.2 9.1a1.4 1.4 0 1 1-2-2l8.1-8"/>' +
      "</svg></span>" +
      '<span class="ai-assist__plus-item-label" id="aiAssistUploadFileLabel">上传文件</span>' +
      "</button>" +
      '<div class="ai-assist__plus-more" id="aiAssistPlusMore">' +
      '<button type="button" class="ai-assist__plus-item ai-assist__plus-item--more" id="aiAssistMoreUpload" role="menuitem" aria-haspopup="menu" aria-expanded="false">' +
      '<span class="ai-assist__plus-item-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
      '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>' +
      "</svg></span>" +
      '<span class="ai-assist__plus-item-label" id="aiAssistMoreUploadLabel">更多上传选项</span>' +
      '<svg class="ai-assist__plus-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<path d="M4.5 2.5L8 6l-3.5 3.5"/>' +
      "</svg></button>" +
      '<div class="ai-assist__plus-submenu" id="aiAssistPlusSubmenu" role="menu" hidden>' +
      '<button type="button" class="ai-assist__plus-item" id="aiAssistUploadAlbum" role="menuitem">' +
      '<span class="ai-assist__plus-item-label" id="aiAssistUploadAlbumLabel">相册</span>' +
      "</button>" +
      '<button type="button" class="ai-assist__plus-item" id="aiAssistUploadNotebook" role="menuitem">' +
      '<span class="ai-assist__plus-item-label" id="aiAssistUploadNotebookLabel">Notebooks</span>' +
      "</button>" +
      "</div></div></div></div>" +
      '<input class="ai-assist__input" id="aiAssistInput" type="text" maxlength="2000" />' +
      '<div class="ai-assist__model" id="aiAssistModel">' +
      '<button type="button" class="ai-assist__model-btn" id="aiAssistModelBtn" aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="ai-assist__model-dot" aria-hidden="true"></span>' +
      '<span class="ai-assist__model-label" id="aiAssistModelLabel">Auto</span>' +
      '<svg class="ai-assist__model-caret" viewBox="0 0 12 12" aria-hidden="true">' +
      '<path d="M3 4.5L6 8l3-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg></button>" +
      '<div class="ai-assist__model-menu" id="aiAssistModelMenu" role="listbox"></div>' +
      "</div>" +
      '<button type="button" class="ai-assist__icon-btn" id="aiAssistMic" aria-label="语音" title="语音">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="3" width="6" height="11" rx="3"/>' +
      '<path d="M5 11a7 7 0 0 0 14 0"/>' +
      '<path d="M12 18v3"/>' +
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

    var plusWrap = root.querySelector("#aiAssistPlus");
    var plusBtn = root.querySelector("#aiAssistPlusBtn");
    var plusMenu = root.querySelector("#aiAssistPlusMenu");
    var plusMore = root.querySelector("#aiAssistPlusMore");
    var plusSubmenu = root.querySelector("#aiAssistPlusSubmenu");
    var moreBtn = root.querySelector("#aiAssistMoreUpload");
    var composerForm = root.querySelector("#aiAssistForm");

    root.querySelector("#aiAssistAgent").addEventListener("click", function (e) {
      e.stopPropagation();
      if (opened) hideAll();
      else openChat();
    });
    root.querySelector("#aiAssistClose").addEventListener("click", function (e) {
      e.stopPropagation();
      hideAll();
    });
    composerForm.addEventListener("submit", function (e) {
      e.preventDefault();
      submitPrompt(inputEl.value);
    });
    inputEl.addEventListener("input", syncSendState);
    root.querySelector("#aiAssistMic").addEventListener("click", function () {
      appendAssistant(t("语音输入即将接入。", "Voice input coming soon."));
    });

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept =
      "image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.pdf,.txt,.md,.doc,.docx,.csv";
    fileInput.hidden = true;
    fileInput.id = "aiAssistFileInput";
    root.appendChild(fileInput);

    var albumInput = document.createElement("input");
    albumInput.type = "file";
    albumInput.accept = "image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif";
    albumInput.hidden = true;
    albumInput.id = "aiAssistAlbumInput";
    root.appendChild(albumInput);

    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (f) handleIncomingFile(f);
    });
    albumInput.addEventListener("change", function () {
      var f = albumInput.files && albumInput.files[0];
      albumInput.value = "";
      if (f) handleIncomingFile(f);
    });

    function isImageFile(file) {
      if (!file) return false;
      if (file.type && file.type.indexOf("image/") === 0) return true;
      var n = String(file.name || "").toLowerCase();
      return /\.(png|jpe?g|webp|bmp|gif|heic|heif)$/.test(n);
    }

    function handleIncomingFile(file) {
      if (!file) return;
      if (!opened) openChat();
      if (isImageFile(file)) {
        runOcrFile(file);
        return;
      }
      appendAssistant(
        t(
          "已收到文件「" + (file.name || "file") + "」。非图片文件的解析即将接入；图片可走 OCR。",
          "Got file “" + (file.name || "file") + "”. Non-image parsing coming soon; images use OCR."
        )
      );
    }

    function pickUploadFile() {
      closePlusMenu();
      fileInput.click();
    }

    function pickAlbum() {
      closePlusMenu();
      albumInput.click();
    }

    function setPlusOpen(open) {
      if (!plusWrap || !plusBtn || !plusMenu) return;
      plusWrap.classList.toggle("is-open", !!open);
      plusBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        plusMenu.removeAttribute("hidden");
      } else {
        plusMenu.setAttribute("hidden", "");
        setMoreOpen(false);
      }
    }

    function setMoreOpen(open) {
      if (!plusMore || !moreBtn || !plusSubmenu) return;
      plusMore.classList.toggle("is-open", !!open);
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) plusSubmenu.removeAttribute("hidden");
      else plusSubmenu.setAttribute("hidden", "");
    }

    function closePlusMenu() {
      setPlusOpen(false);
    }

    function togglePlusMenu() {
      var open = !(plusWrap && plusWrap.classList.contains("is-open"));
      if (open) closeModelMenu();
      setPlusOpen(open);
    }

    plusBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePlusMenu();
    });
    plusMenu.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    root.querySelector("#aiAssistUploadFile").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      pickUploadFile();
    });
    moreBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(!(plusMore && plusMore.classList.contains("is-open")));
    });
    root.querySelector("#aiAssistUploadAlbum").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      pickAlbum();
    });
    root.querySelector("#aiAssistUploadNotebook").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closePlusMenu();
      appendAssistant(t("Notebooks 即将接入。", "Notebooks coming soon."));
    });

    function runOcrFile(file) {
      if (!file) return;
      appendAssistant(
        t("正在识别图片：", "Recognizing image: ") + (file.name || "image") + "…"
      );
      var fd = new FormData();
      fd.append("file", file, file.name || "upload.jpg");
      fetch("/api/ocr", { method: "POST", body: fd })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (pack) {
          var data = pack.data || {};
          if (!pack.ok || data.success === false) {
            appendAssistant(
              t("识别失败：", "OCR failed: ") +
                (data.error || data.detail || "unknown")
            );
            return;
          }
          var text = String(data.text || "").trim();
          if (!text) {
            appendAssistant(t("未识别到文字。", "No text recognized."));
            return;
          }
          appendAssistant(t("识别结果：\n", "OCR result:\n") + text);
          if (inputEl && !String(inputEl.value || "").trim()) {
            inputEl.value =
              t("请根据这张图的文字回答：\n", "Based on this OCR text, answer:\n") +
              text;
            syncSendState();
          }
        })
        .catch(function (err) {
          appendAssistant(
            t("识别请求失败：", "OCR request failed: ") +
              String((err && err.message) || err)
          );
        });
    }

    function onPasteFiles(e) {
      if (!opened || !visible) return;
      var cd = e.clipboardData;
      if (!cd) return;
      var items = cd.items || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it && it.kind === "file") {
          var f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length && cd.files && cd.files.length) {
        for (var j = 0; j < cd.files.length; j++) files.push(cd.files[j]);
      }
      if (!files.length) return;
      e.preventDefault();
      handleIncomingFile(files[0]);
    }

    inputEl.addEventListener("paste", onPasteFiles);
    composerForm.addEventListener("paste", onPasteFiles);

    var dragDepth = 0;
    function hasFilesInDataTransfer(dt) {
      if (!dt) return false;
      if (dt.files && dt.files.length) return true;
      if (dt.types) {
        for (var i = 0; i < dt.types.length; i++) {
          if (dt.types[i] === "Files") return true;
        }
      }
      return false;
    }
    composerForm.addEventListener("dragenter", function (e) {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      composerForm.classList.add("is-dragover");
    });
    composerForm.addEventListener("dragover", function (e) {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      composerForm.classList.add("is-dragover");
    });
    composerForm.addEventListener("dragleave", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) composerForm.classList.remove("is-dragover");
    });
    composerForm.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      composerForm.classList.remove("is-dragover");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleIncomingFile(files[0]);
    });

    modelBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closePlusMenu();
      toggleModelMenu();
    });
    modelMenu.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    root.addEventListener("click", function (e) {
      e.stopPropagation();
      closeModelMenu();
      closePlusMenu();
    });

    document.addEventListener("click", function () {
      closeModelMenu();
      closePlusMenu();
    });

    // expose for hide/open cleanup
    root._aiClosePlusMenu = closePlusMenu;

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
    var uploadLabel = root.querySelector("#aiAssistUploadFileLabel");
    var moreLabel = root.querySelector("#aiAssistMoreUploadLabel");
    var albumLabel = root.querySelector("#aiAssistUploadAlbumLabel");
    var nbLabel = root.querySelector("#aiAssistUploadNotebookLabel");
    if (uploadLabel) uploadLabel.textContent = t("上传文件", "Upload files");
    if (moreLabel) moreLabel.textContent = t("更多上传选项", "More upload options");
    if (albumLabel) albumLabel.textContent = t("相册", "Photos");
    if (nbLabel) nbLabel.textContent = "Notebooks";
    var plusBtn = root.querySelector("#aiAssistPlusBtn");
    if (plusBtn) plusBtn.setAttribute("aria-label", t("添加", "Add"));
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

  function closePlusMenuSafe() {
    if (root && typeof root._aiClosePlusMenu === "function") root._aiClosePlusMenu();
  }

  function showLauncher() {
    ensureDom();
    renderCopy();
    visible = true;
    opened = false;
    root.classList.add("is-visible");
    root.classList.remove("is-open");
    closeModelMenu();
    closePlusMenuSafe();
    syncChattingClass();
    root.setAttribute("aria-hidden", "false");
    syncNavActive();
  }

  function hideAll() {
    if (!root) return;
    visible = false;
    opened = false;
    closeModelMenu();
    closePlusMenuSafe();
    root.classList.remove("is-visible", "is-open");
    root.setAttribute("aria-hidden", "true");
    syncNavActive();
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
    syncNavActive();
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
    closePlusMenuSafe();
    root.classList.remove("is-open");
    root.classList.add("is-visible");
    syncNavActive();
  }

  function syncNavActive() {
    var link = document.getElementById("topNavAiAssist");
    if (!link) return;
    link.classList.toggle("is-active", !!visible);
    link.setAttribute("aria-expanded", visible ? "true" : "false");
  }

  function toggleFromNav() {
    ensureDom();
    // 左上角「AI助手」：显示 agent ↔ 再点一次整组消失
    if (visible) hideAll();
    else showLauncher();
    syncNavActive();
  }

  function bindNav() {
    var link = document.getElementById("topNavAiAssist");
    if (!link || link.dataset.aiBound === "1") return;
    link.dataset.aiBound = "1";
    link.setAttribute("aria-expanded", "false");
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
    if (root && root.querySelector(".ai-assist__plus.is-open")) {
      closePlusMenuSafe();
      return;
    }
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
