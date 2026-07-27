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
  var BUILTIN_OPTIONS = [
    {
      id: "auto",
      label: "Auto",
      descZh: "按意图自动选梯队",
      descEn: "Routes by intent",
      tier: 0,
    },
  ];
  var MODEL_OPTIONS = BUILTIN_OPTIONS.slice();
  var registryModels = [];

  /** 最近一次 OCR 结果，随下一条消息带给 /api/llm-chat 后清空 */
  var pendingOcr = null;
  /** 输入框附件：{ kind, name, file, previewUrl, ext } */
  var pendingAttachment = null;
  var ocrAbort = null;
  var attachStrip = null;
  var lightboxEl = null;

  /** 排版硬校验原因码 → 文案 */
  var LAYOUT_REASONS = {
    multi_column: ["多栏排版", "multi-column"],
    table_like: ["表格/表单结构", "table-like"],
    low_confidence: ["识别置信度低", "low confidence"],
    severe_skew: ["严重倾斜", "severely skewed"],
    skewed: ["轻微倾斜", "slightly skewed"],
    mixed_font_size: ["字号混杂", "mixed font sizes"],
    dense_text: ["文本超密", "dense text"],
    sparse_text: ["文字稀疏", "sparse text"],
    no_text: ["未识别到文字", "no text found"],
    no_box: ["无有效文本框", "no valid boxes"],
  };

  function layoutReasonText(codes, en) {
    return (codes || [])
      .map(function (c) {
        var pair = LAYOUT_REASONS[c];
        return pair ? (en ? pair[1] : pair[0]) : c;
      })
      .join(en ? ", " : "、");
  }

  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf("image/") === 0) return true;
    var n = String(file.name || "").toLowerCase();
    return /\.(png|jpe?g|webp|bmp|gif|heic|heif)$/.test(n);
  }

  function isPdfFile(file) {
    if (!file) return false;
    if (file.type === "application/pdf") return true;
    return /\.pdf$/i.test(String(file.name || ""));
  }

  function fileExt(name) {
    var m = String(name || "").match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : "FILE";
  }

  function fileBaseName(name) {
    var n = String(name || "file");
    return n.replace(/\.[^.]+$/, "") || n;
  }

  function escapeChipText(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.hidden = true;
    var img = lightboxEl.querySelector("#aiAssistLightboxImg");
    if (img) img.removeAttribute("src");
  }

  function openLightbox(url) {
    if (!lightboxEl || !url) return;
    var img = lightboxEl.querySelector("#aiAssistLightboxImg");
    if (img) img.src = url;
    lightboxEl.hidden = false;
  }

  function clearAttachment(opts) {
    opts = opts || {};
    if (ocrAbort) {
      try {
        ocrAbort.abort();
      } catch (e) {}
      ocrAbort = null;
    }
    if (pendingAttachment && pendingAttachment.previewUrl) {
      try {
        URL.revokeObjectURL(pendingAttachment.previewUrl);
      } catch (e2) {}
    }
    pendingAttachment = null;
    if (!opts.keepOcr) pendingOcr = null;
    closeLightbox();
    renderAttachment();
    syncSendState();
  }

  function renderAttachment() {
    if (!attachStrip) return;
    attachStrip.innerHTML = "";
    if (!pendingAttachment) {
      attachStrip.hidden = true;
      return;
    }
    attachStrip.hidden = false;
    var a = pendingAttachment;
    var chip = document.createElement("div");
    chip.className =
      "ai-assist__attach-chip" + (a.kind === "image" ? " is-image" : " is-file");
    if (a.kind === "image" && a.previewUrl) {
      chip.innerHTML =
        '<button type="button" class="ai-assist__attach-preview" data-act="preview" aria-label="' +
        t("放大预览", "Enlarge preview") +
        '">' +
        '<img src="' +
        a.previewUrl +
        '" alt="" />' +
        "</button>";
    } else {
      chip.innerHTML =
        '<div class="ai-assist__attach-file" aria-hidden="true">' +
        '<span class="ai-assist__attach-ext">' +
        (a.ext || "FILE") +
        "</span>" +
        '<span class="ai-assist__attach-name">' +
        escapeChipText(a.baseName || a.name) +
        "</span>" +
        "</div>";
    }
    chip.innerHTML +=
      '<button type="button" class="ai-assist__attach-remove" data-act="remove" aria-label="' +
      t("取消附件", "Remove attachment") +
      '">&times;</button>';
    chip.title =
      a.kind === "image"
        ? t("点击放大预览", "Click to enlarge")
        : a.name || a.ext || "";
    chip.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      var act = btn ? btn.getAttribute("data-act") : "";
      if (act === "remove") {
        e.preventDefault();
        e.stopPropagation();
        clearAttachment();
        return;
      }
      if (a.kind === "image" && (act === "preview" || !btn)) {
        openLightbox(a.previewUrl);
      }
    });
    attachStrip.appendChild(chip);
    var isPdf = a.kind === "pdf";
    if (a.ocrStatus === "running") {
      var tip = document.createElement("span");
      tip.className = "ai-assist__attach-tip";
      tip.textContent = isPdf
        ? t("PDF 提取中…", "Extracting PDF…")
        : t("OCR 识别中…", "OCR running…");
      attachStrip.appendChild(tip);
    } else if (a.ocrStatus === "done") {
      var tip2 = document.createElement("span");
      tip2.className = "ai-assist__attach-tip";
      tip2.textContent = isPdf
        ? t("PDF 已提取，可提问", "PDF ready — ask away")
        : t("OCR 完成，可提问", "OCR ready — ask away");
      attachStrip.appendChild(tip2);
    } else if (a.ocrStatus === "fail") {
      var tip3 = document.createElement("span");
      tip3.className = "ai-assist__attach-tip is-error";
      tip3.textContent = isPdf
        ? t("PDF 提取失败", "PDF extract failed")
        : t("OCR 失败", "OCR failed");
      attachStrip.appendChild(tip3);
    }
  }

  function stageAttachment(file) {
    if (!file) return;
    ensureDom();
    if (!opened) openChat();
    clearAttachment();

    var kind = isImageFile(file) ? "image" : isPdfFile(file) ? "pdf" : "other";
    var previewUrl = kind === "image" ? URL.createObjectURL(file) : "";
    pendingAttachment = {
      kind: kind,
      name: file.name || (kind === "pdf" ? "document.pdf" : "file"),
      baseName: fileBaseName(file.name || (kind === "pdf" ? "document" : "file")),
      ext: kind === "pdf" ? "PDF" : fileExt(file.name),
      file: file,
      previewUrl: previewUrl,
      ocrStatus: kind === "image" || kind === "pdf" ? "running" : "",
    };
    renderAttachment();
    syncSendState();
    if (kind === "image" || kind === "pdf") runOcrFile(file);
  }

  /** 明细报告：图片走 RapidOCR；PDF 走 pypdf 文本提取 */
  function ocrReportText(data, en) {
    var isPdf = data.source === "pdf" || (data.page_count != null && !data.image);
    var lines = Array.isArray(data.lines) ? data.lines : [];
    var lay = data.layout || {};
    var m = lay.metrics || {};
    var img = data.image || {};
    var out = [];
    out.push(
      isPdf
        ? en
          ? "[PDF text extract · pypdf]"
          : "【PDF 文本提取 · pypdf】"
        : en
          ? "[RapidOCR + ONNX Runtime]"
          : "【RapidOCR + ONNX Runtime】"
    );

    if (isPdf) {
      out.push(
        (en ? "pages " : "页数 ") +
          (data.page_count != null ? data.page_count : "?") +
          " · " +
          (en ? "chars " : "字符 ") +
          (m.char_count != null ? m.char_count : String(data.text || "").length) +
          " · " +
          (en ? "lines " : "行数 ") +
          (data.line_count || 0)
      );
    } else {
      var elapse = Array.isArray(data.elapse)
        ? data.elapse
            .map(function (x) {
              return typeof x === "number" ? Math.round(x * 1000) + "ms" : String(x);
            })
            .join(" / ")
        : "";
      out.push(
        (en ? "image " : "图片 ") +
          (img.width || "?") +
          "×" +
          (img.height || "?") +
          " · " +
          (en ? "lines " : "行数 ") +
          (data.line_count || 0) +
          (m.mean_score != null
            ? " · " + (en ? "avg conf " : "平均置信 ") + m.mean_score
            : "") +
          (elapse ? " · det/cls/rec " + elapse : "")
      );
    }

    out.push(
      (en ? "layout: " : "排版硬校验：") +
        (lay.complex ? (en ? "COMPLEX" : "复杂") : en ? "simple" : "简单") +
        " · " +
        (en ? "suggested tier " : "建议梯队 ") +
        (lay.suggested_tier || "?") +
        ((lay.reasons || []).length
          ? " · " + layoutReasonText(lay.reasons, en)
          : "")
    );

    if (!isPdf) {
      out.push(
        (en ? "metrics: columns " : "指标：栏数 ") +
          (m.columns != null ? m.columns : "?") +
          (en ? ", side-by-side " : "，左右并排比 ") +
          (m.side_by_side_ratio != null ? m.side_by_side_ratio : "?") +
          (en ? ", skew " : "，倾斜 ") +
          (m.mean_skew_deg != null ? m.mean_skew_deg + "°" : "?") +
          (en ? ", height CV " : "，字高变异 ") +
          (m.height_cv != null ? m.height_cv : "?") +
          (en ? ", coverage " : "，文字覆盖 ") +
          (m.text_coverage != null ? m.text_coverage : "?")
      );
    }

    if (!String(data.text || "").trim()) {
      out.push(
        isPdf
          ? en
            ? "\nNo extractable text (likely a scanned PDF)."
            : "\n未提取到文字（多半是扫描件 PDF）。"
          : en
            ? "\nNo text recognized."
            : "\n未识别到文字。"
      );
      return out.join("\n");
    }

    if (isPdf) {
      out.push(en ? "\nExtracted text (preview):" : "\n提取文本（预览）：");
      out.push(String(data.text).slice(0, 2500));
      if (String(data.text).length > 2500) {
        out.push(en ? "\n… truncated" : "\n… 已截断");
      }
      return out.join("\n");
    }

    out.push(en ? "\nLines (text · conf · box):" : "\n逐行结果（文字 · 置信 · 坐标）：");
    lines.slice(0, 30).forEach(function (ln, i) {
      var box = ln.box || [];
      var xs = box.map(function (p) {
        return Math.round(Number(p[0]) || 0);
      });
      var ys = box.map(function (p) {
        return Math.round(Number(p[1]) || 0);
      });
      var rect = xs.length
        ? "[" +
          Math.min.apply(null, xs) +
          "," +
          Math.min.apply(null, ys) +
          " → " +
          Math.max.apply(null, xs) +
          "," +
          Math.max.apply(null, ys) +
          "]"
        : "";
      out.push(
        String(i + 1) +
          ". " +
          String(ln.text || "") +
          "  ·  " +
          (ln.score != null ? Number(ln.score).toFixed(3) : "?") +
          "  ·  " +
          rect
      );
    });
    if (lines.length > 30) {
      out.push(
        en
          ? "… " + (lines.length - 30) + " more lines"
          : "… 另有 " + (lines.length - 30) + " 行"
      );
    }
    return out.join("\n");
  }

  function ocrRoutingNote(data, en) {
    var lay = data.layout || {};
    var isPdf = data.source === "pdf";
    if (!String(data.text || "").trim()) {
      return isPdf
        ? en
          ? "No text extracted — scanned PDF may need a vision model"
          : "未提取到文字——扫描件 PDF 可能需要识图模型"
        : en
          ? "Nothing to route — try a clearer image"
          : "无文字可路由，换张更清晰的图试试";
    }
    return en
      ? (isPdf ? "PDF text" : "OCR text") +
          " goes to the intent classifier; layout check floors routing at tier " +
          (lay.suggested_tier || "?") +
          ". Ask your question now."
      : (isPdf ? "PDF 文本" : "OCR 文字") +
          "将交给意图分类器，排版硬校验把梯队下限定在 tier" +
          (lay.suggested_tier || "?") +
          "。现在提问即可。";
  }

  function runOcrFile(file) {
    if (!file) return;
    if (ocrAbort) {
      try {
        ocrAbort.abort();
      } catch (e) {}
    }
    ocrAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    var fd = new FormData();
    fd.append("file", file, file.name || "upload.jpg");
    fetch("/api/ocr", {
      method: "POST",
      body: fd,
      signal: ocrAbort ? ocrAbort.signal : undefined,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (pack) {
        if (
          !pendingAttachment ||
          !pendingAttachment.file ||
          pendingAttachment.file !== file
        ) {
          return;
        }
        var data = pack.data || {};
        if (!pack.ok || data.success === false) {
          pendingAttachment.ocrStatus = "fail";
          renderAttachment();
          appendAssistant(
            t("识别失败：", "OCR failed: ") +
              (data.error || data.detail || "unknown")
          );
          return;
        }
        var text = String(data.text || "").trim();
        var en = currentLang() === "en";
        pendingOcr = {
          text: text,
          line_count: data.line_count || 0,
          layout: data.layout || null,
          source: data.source || (data.page_count != null ? "pdf" : "image"),
          page_count: data.page_count || null,
        };
        if (!text) pendingOcr = null;
        pendingAttachment.ocrStatus = "done";
        renderAttachment();
        var isPdf = (data.source || pendingAttachment.kind) === "pdf";
        appendAssistant(ocrReportText(data, en), {
          modelBadge: isPdf ? "PDF · pypdf" : "RapidOCR + ONNX Runtime",
          modelNote: ocrRoutingNote(data, en),
          mono: true,
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (pendingAttachment && pendingAttachment.file === file) {
          pendingAttachment.ocrStatus = "fail";
          renderAttachment();
        }
        appendAssistant(
          t("识别请求失败：", "OCR request failed: ") +
            String((err && err.message) || err)
        );
      });
  }

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

  function capsDesc(caps, langEn) {
    var c = caps || {};
    var bits = [];
    if (c.vision) bits.push(langEn ? "Vision" : "视觉");
    if (c.video) bits.push(langEn ? "Video" : "视频");
    if (c.ocr) bits.push("OCR");
    if (!bits.length) bits.push(langEn ? "Text" : "文本");
    return bits.join(" · ");
  }

  function rebuildModelOptions() {
    var langEn = currentLang() === "en";
    var opts = BUILTIN_OPTIONS.slice();
    var sorted = registryModels.slice().sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return (a.order || 0) - (b.order || 0);
    });
    sorted.forEach(function (m) {
      var tierName =
        m.tier === 1
          ? langEn
            ? "Tier 1"
            : "第一梯队"
          : m.tier === 3
            ? langEn
              ? "Tier 3"
              : "第三梯队"
            : langEn
              ? "Tier 2"
              : "第二梯队";
      opts.push({
        id: m.id,
        label: m.label || m.modelId,
        descZh: tierName + " · " + capsDesc(m.caps, false),
        descEn: tierName + " · " + capsDesc(m.caps, true),
        tier: m.tier,
        caps: m.caps,
      });
    });
    MODEL_OPTIONS = opts;
    if (!MODEL_OPTIONS.some(function (o) { return o.id === selectedModelId; })) {
      selectedModelId = "auto";
    }
  }

  function reloadModels() {
    var fetcher =
      global.AiAssistModels && global.AiAssistModels.fetchPickerModels
        ? global.AiAssistModels.fetchPickerModels
        : function () {
            return fetch("/api/llm-models", { cache: "no-store" })
              .then(function (r) {
                return r.json();
              })
              .then(function (j) {
                return (j && j.models) || [];
              })
              .catch(function () {
                return [];
              });
          };
    return fetcher().then(function (list) {
      registryModels = list || [];
      rebuildModelOptions();
      renderModelMenu();
      syncModelUi();
    });
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
      '<div class="ai-assist__panel" id="aiAssistPanel">' +
      '<div class="ai-assist__thread" id="aiAssistThread" aria-live="polite"></div>' +
      "</div>" +
      '<div class="ai-assist__prompts" id="aiAssistPrompts" role="list"></div>' +
      '<form class="ai-assist__composer" id="aiAssistForm" autocomplete="off">' +
      '<div class="ai-assist__attach" id="aiAssistAttach" hidden></div>' +
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

    attachStrip = root.querySelector("#aiAssistAttach");

    lightboxEl = document.createElement("div");
    lightboxEl.className = "ai-assist__lightbox";
    lightboxEl.id = "aiAssistLightbox";
    lightboxEl.hidden = true;
    lightboxEl.innerHTML =
      '<button type="button" class="ai-assist__lightbox-close" id="aiAssistLightboxClose" aria-label="关闭">&times;</button>' +
      '<img class="ai-assist__lightbox-img" id="aiAssistLightboxImg" alt="" />';
    root.appendChild(lightboxEl);
    lightboxEl.addEventListener("click", function (e) {
      if (e.target === lightboxEl || e.target.id === "aiAssistLightboxClose") {
        closeLightbox();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && lightboxEl && !lightboxEl.hidden) {
        closeLightbox();
      }
    });

    function handleIncomingFile(file) {
      if (!file) return;
      stageAttachment(file);
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

    /** OCR helpers live at module scope (runOcrFile / ocrReportText) */

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
    var closeBtn = root.querySelector("#aiAssistClose");
    if (closeBtn) closeBtn.setAttribute("aria-label", t("关闭", "Close"));
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
      'By chatting with us, you agree to our <a href="#" id="aiAssistPrivacy">Privacy Policy</a>.'
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

  function formatModelBadge(meta, selectedId) {
    if (!meta) {
      var sel = findModel(selectedId || selectedModelId);
      return sel && sel.id === "auto" ? "Auto" : (sel && sel.label) || "";
    }
    var name = meta.label || meta.modelId || "";
    if (meta.via && String(meta.via).indexOf("auto") === 0) {
      var tierTag = meta.tier ? " · T" + meta.tier : "";
      return "Auto → " + name + tierTag;
    }
    return name;
  }

  function renderThread() {
    if (!threadEl) return;
    threadEl.innerHTML = "";
    messages.forEach(function (m) {
      var bubble = document.createElement("div");
      bubble.className =
        "ai-assist__bubble ai-assist__bubble--" +
        (m.role === "user" ? "user" : "assistant") +
        (m.mono ? " ai-assist__bubble--mono" : "");
      if (m.role === "assistant" && m.modelBadge) {
        var meta = document.createElement("div");
        meta.className = "ai-assist__bubble-model";
        meta.textContent = m.modelBadge;
        bubble.appendChild(meta);
      }
      var body = document.createElement("div");
      body.className = "ai-assist__bubble-text";
      body.textContent = m.text;
      bubble.appendChild(body);
      if (m.role === "assistant" && m.modelNote) {
        var note = document.createElement("div");
        note.className = "ai-assist__bubble-note";
        note.textContent = m.modelNote;
        bubble.appendChild(note);
      }
      threadEl.appendChild(bubble);
    });
    threadEl.scrollTop = threadEl.scrollHeight;
    syncChattingClass();
  }

  function appendMessage(role, text, extra) {
    var row = {
      role: role,
      text: String(text || ""),
      model: selectedModelId,
    };
    if (extra && typeof extra === "object") {
      if (extra.modelBadge) row.modelBadge = extra.modelBadge;
      if (extra.modelMeta) row.modelMeta = extra.modelMeta;
      if (extra.modelNote) row.modelNote = extra.modelNote;
      if (extra.mono) row.mono = true;
    }
    messages.push(row);
    renderThread();
  }

  function appendAssistant(text, extra) {
    appendMessage("assistant", text, extra);
  }

  function submitPrompt(text) {
    var q = String(text || "").trim();
    if (!q) return;
    if (!opened) openChat();
    var phone = currentPhone();
    var want = selectedModelId;
    if (!messages.length) {
      appendMessage(
        "assistant",
        t(
          "你好，我是 HZDV AI 助手。",
          "Hi there, you’re speaking with HZDV AI Agent."
        ),
        { modelBadge: "" }
      );
    }
    appendMessage("user", q);
    inputEl.value = "";

    var ocrCtx = pendingOcr;
    pendingOcr = null;
    var attachWas =
      pendingAttachment && pendingAttachment.kind
        ? pendingAttachment.kind
        : "";
    var attachStillRunning =
      pendingAttachment && pendingAttachment.ocrStatus === "running";
    // 发送后清掉输入框缩略图；OCR/PDF 上下文已拷到本次请求
    clearAttachment({ keepOcr: true });
    pendingOcr = null;
    syncSendState();

    if (!phone) {
      appendAssistant(
        t("请先登录后再对话。", "Please log in to chat."),
        { modelBadge: formatModelBadge(null, want) }
      );
      return;
    }

    if (attachStillRunning) {
      appendAssistant(
        t(
          "附件还在提取中，请等缩略图旁提示「可提问」后再发送。",
          "Attachment is still extracting — wait until the chip says ready, then send."
        )
      );
      return;
    }
    if (attachWas && !ocrCtx) {
      appendAssistant(
        t(
          "附件未提取到文字（扫描件 PDF 常见）。可换可复制文字的 PDF，或等识图模型接入。",
          "No text extracted from the attachment (common for scanned PDFs). Try a text PDF, or wait for vision models."
        )
      );
    }

    appendAssistant(t("思考中…", "Thinking…"), {
      modelBadge: want === "auto" ? "Auto …" : formatModelBadge(null, want),
    });
    var thinkingIdx = messages.length - 1;

    var ocrCtx = pendingOcr;
    pendingOcr = null;

    fetch("/api/llm-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        phone: phone,
        message: q,
        modelId: want,
        lang: currentLang(),
        ocr: ocrCtx || undefined,
      }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (pack) {
        var j = pack.j || {};
        var badge = formatModelBadge(j.model, want);
        var latency =
          j.latencyMs != null ? " · " + j.latencyMs + "ms" : "";
        var note = (j.notes || []).join("；") || "";
        if (j.success && j.reply) {
          messages[thinkingIdx] = {
            role: "assistant",
            text: String(j.reply),
            model: want,
            modelBadge: badge + latency,
            modelNote: note,
            modelMeta: j.model || null,
          };
        } else {
          var errText = j.error || "";
          if (!errText && j.upstreamStatus) {
            errText = "HTTP " + j.upstreamStatus;
          }
          if (!errText && j.upstream) {
            try {
              errText = JSON.stringify(j.upstream).slice(0, 240);
            } catch (e2) {
              errText = "";
            }
          }
          if (!errText) {
            errText = pack.ok
              ? t("上游返回空内容或无法解析", "Empty or unreadable upstream reply")
              : t("请求失败（无详细错误）", "Request failed (no detail)");
          }
          messages[thinkingIdx] = {
            role: "assistant",
            text: t("调用失败：", "Failed: ") + errText,
            model: want,
            modelBadge: (badge || "LLM") + latency,
            modelNote: note,
            modelMeta: j.model || null,
          };
        }
        renderThread();
      })
      .catch(function (err) {
        messages[thinkingIdx] = {
          role: "assistant",
          text: t("网络错误：", "Network error: ") + String((err && err.message) || err),
          model: want,
          modelBadge: formatModelBadge(null, want),
        };
        renderThread();
      });
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
    closeLightbox();
    clearAttachment();
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
    reloadModels: reloadModels,
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

  // 首次拉取注册表
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      reloadModels();
    });
  } else {
    reloadModels();
  }
})(typeof window !== "undefined" ? window : this);
