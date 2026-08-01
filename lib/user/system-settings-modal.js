/**
 * 系统参数设置（独立弹窗）
 * 暂不鉴权：谁都可以打开/保存，调通后再收紧为超管。
 * 数据：D1 user_settings，固定 user_id = __system__
 */
(function () {
  "use strict";

  var SYSTEM_USER_ID = "__system__";
  var STORAGE_KEY = "hzdv_system_settings";

  /** 与 functions/api/user-settings.js DEFAULT_SETTINGS 保持一致 */
  var DEFAULTS = {
    ocrPreviewChars: 4500,
    ocrTextMaxPdf: 14000,
    ocrTextMaxImage: 6000,
    ocrVisionMaxPages: 6,
    pdfVisionMaxPages: 6,
    pdfRenderDpi: 120,
    /**
     * OCR 聊天预览：1=聊天区显示开发者明细（排版/送模文本/逐行）；0=不展开全文
     */
    ocrShowDevPreview: 1,
    /**
     * OCR 送 LLM：1=结果随下一条用户消息带给模型；0=不送（仅本地预览或丢弃）
     */
    ocrSendToLlm: 1,
    /**
     * 麦克风识别模式（互斥三选一）：
     * 0 = 整段录完再识别（SenseVoice Small ONNX 离线）
     * 1 = 客户端能量 VAD 断句 + SenseVoice 离线上屏
     * 2 = 服务端 Silero VAD + SenseVoice Small ONNX 模拟流式（边说边上屏）
     */
    asrMicMode: 1,
    /** Tavily：返回条数 1–10 */
    tavilyMaxResults: 5,
    /** Tavily：0=basic，1=advanced */
    tavilySearchDepth: 0,
    /**
     * AI 助手：1=气泡下显示意图分类/联网/路由/模型调用跟踪；0=不显示
     */
    llmShowPipelineTrace: 0,
    /**
     * 调试：1=Auto 在③生成前强制模拟墙钟失败，以测试失败恢复编排；0=正常
     */
    llmForceFailGenerate: 0,
    /**
     * Auto 路由模式：
     * 0 = 方案一 vps（意图 VPS 1.5B；生成可经 llm-proxy）
     * 1 = 方案二 cf（意图云端 7B；生成 CF 直调云端，国内友好）
     */
    llmRouteMode: 0,
  };

  /**
   * category = 业务大类（列「分类」）。当前全是 PDF 提取相关；
   * 今后可加「用户权限」「网站背景」等，同大类可折叠。
   * 描述前缀区分环节：预览 / 送模 / 渲图。
   */
  var PARAM_ROWS = [
    {
      category: "PDF内容提取",
      field: "ocrPreviewChars",
      desc: "预览：聊天区 OCR/PDF 预览字数",
      value: 4500,
      unit: "字符",
    },
    {
      category: "PDF内容提取",
      field: "ocrTextMaxPdf",
      desc: "送模：送 LLM 的 PDF 文本上限",
      value: 14000,
      unit: "字符",
    },
    {
      category: "PDF内容提取",
      field: "ocrTextMaxImage",
      desc: "送模：送 LLM 的图片 OCR 文本上限",
      value: 6000,
      unit: "字符",
    },
    {
      category: "PDF内容提取",
      field: "ocrVisionMaxPages",
      desc: "送模：对话附带复杂页渲图上限",
      value: 6,
      unit: "页",
    },
    {
      category: "PDF内容提取",
      field: "pdfVisionMaxPages",
      desc: "渲图：OCR 服务复杂页渲图上限",
      value: 6,
      unit: "页",
    },
    {
      category: "PDF内容提取",
      field: "pdfRenderDpi",
      desc: "渲图：PDF 整页渲图 DPI",
      value: 120,
      unit: "DPI",
    },
    {
      category: "OCR输出",
      field: "ocrShowDevPreview",
      desc: "给我看：聊天区显示 OCR 开发者预览（1开/0关）",
      value: 1,
      unit: "0/1",
    },
    {
      category: "OCR输出",
      field: "ocrSendToLlm",
      desc: "送LLM：结果随下一条消息送模型；关预览=只给LLM（1开/0关）",
      value: 1,
      unit: "0/1",
    },
    {
      category: "语音识别",
      field: "asrMicMode",
      desc: "麦克风：0整段离线 / 1客户端VAD断句 / 2 SenseVoice+VAD模拟流式",
      value: 1,
      unit: "0/1/2",
    },
    {
      category: "联网检索",
      field: "tavilyMaxResults",
      desc: "Tavily：每次检索返回条数",
      value: 5,
      unit: "条",
    },
    {
      category: "联网检索",
      field: "tavilySearchDepth",
      desc: "Tavily：深度 0=basic（省配额）/ 1=advanced",
      value: 0,
      unit: "0/1",
    },
    {
      category: "AI助手",
      field: "llmShowPipelineTrace",
      desc: "调试：气泡下显示意图分类与各步调用过程",
      value: 0,
      unit: "0/1",
    },
    {
      category: "AI助手",
      field: "llmForceFailGenerate",
      desc: "调试：强制模拟③生成墙钟失败（测失败恢复；测完改回0）",
      value: 0,
      unit: "0/1",
    },
    {
      category: "AI助手",
      field: "llmRouteMode",
      desc: "路由：0=方案一VPS（1.5B+可选proxy）/ 1=方案二CF（7B意图+直调云端）",
      value: 0,
      unit: "0/1",
    },
  ];

  /** 折叠状态：true = 该大类已收起 */
  var collapsedCats = {};

  var template =
    '<div class="settings-modal-overlay" id="settingsModalOverlay" aria-hidden="true">' +
    '<div class="settings-modal-sheet" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">' +
    '<button type="button" class="settings-modal-close" id="settingsModalCloseBtn" aria-label="关闭">&times;</button>' +
    '<h2 id="settingsModalTitle" class="settings-modal-title">系统参数设置</h2>' +
    '<div id="settingsGrid" class="ag-theme-quartz" style="height:320px;width:100%;"></div>' +
    '<div id="settingsStatus" class="settings-status"></div>' +
    "</div>" +
    "</div>";

  if (!document.getElementById("settingsModalOverlay")) {
    var mount = document.createElement("div");
    mount.innerHTML = template;
    document.body.appendChild(mount.firstElementChild);
  }

  var overlay = document.getElementById("settingsModalOverlay");
  var closeBtn = document.getElementById("settingsModalCloseBtn");
  var gridEl = document.getElementById("settingsGrid");
  var statusEl = document.getElementById("settingsStatus");
  var gridApi = null;
  var bodyOverflowPrev = "";

  function clampInt(v, min, max, fallback) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function mergeSettings(saved) {
    var out = {};
    for (var k in DEFAULTS) {
      if (!DEFAULTS.hasOwnProperty(k)) continue;
      out[k] = saved && saved[k] != null ? saved[k] : DEFAULTS[k];
    }
    // 兼容旧字段 asrVadLive → asrMicMode
    if (saved && saved.asrMicMode == null && saved.asrVadLive != null) {
      var legacy = parseInt(saved.asrVadLive, 10);
      out.asrMicMode = legacy === 0 ? 0 : 1;
    }
    out.asrMicMode = clampInt(out.asrMicMode, 0, 2, DEFAULTS.asrMicMode);
    out.tavilyMaxResults = clampInt(
      out.tavilyMaxResults,
      1,
      10,
      DEFAULTS.tavilyMaxResults
    );
    out.tavilySearchDepth = clampInt(
      out.tavilySearchDepth,
      0,
      1,
      DEFAULTS.tavilySearchDepth
    );
    out.llmShowPipelineTrace = clampInt(
      out.llmShowPipelineTrace,
      0,
      1,
      DEFAULTS.llmShowPipelineTrace
    );
    out.llmForceFailGenerate = clampInt(
      out.llmForceFailGenerate,
      0,
      1,
      DEFAULTS.llmForceFailGenerate
    );
    out.llmRouteMode = clampInt(
      out.llmRouteMode,
      0,
      1,
      DEFAULTS.llmRouteMode
    );
    return out;
  }

  function applyLocal(settings) {
    var s = mergeSettings(settings);
    window.__HZDV_SYSTEM_SETTINGS = s;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {}
    if (typeof window.onHzdvSystemSettingsChange === "function") {
      try {
        window.onHzdvSystemSettingsChange(s);
      } catch (e2) {}
    }
    return s;
  }

  function readCached() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return mergeSettings(JSON.parse(raw));
    } catch (e) {}
    return mergeSettings(null);
  }

  function getLeafRows(settings) {
    var s = mergeSettings(settings);
    return PARAM_ROWS.map(function (r) {
      return {
        category: r.category,
        field: r.field,
        desc: r.desc,
        unit: r.unit,
        value: s[r.field] != null ? s[r.field] : r.value,
        __group: false,
      };
    });
  }

  function getDisplayRows(settings) {
    var leaf = getLeafRows(settings);
    var order = [];
    var byCat = {};
    for (var i = 0; i < leaf.length; i++) {
      var r = leaf[i];
      if (!byCat[r.category]) {
        byCat[r.category] = [];
        order.push(r.category);
      }
      byCat[r.category].push(r);
    }
    var out = [];
    for (var c = 0; c < order.length; c++) {
      var cat = order[c];
      var collapsed = !!collapsedCats[cat];
      var kids = byCat[cat] || [];
      out.push({
        __group: true,
        category: cat,
        field: "__group__:" + cat,
        desc: collapsed ? "点击展开 · " + kids.length + " 项" : "点击折叠 · " + kids.length + " 项",
        value: "",
        unit: "",
      });
      if (!collapsed) {
        for (var k = 0; k < kids.length; k++) out.push(kids[k]);
      }
    }
    return out;
  }

  function toggleCategory(cat) {
    if (!cat) return;
    // 折叠前把当前编辑写入内存，避免收起后丢改动
    applyLocal(collectFromGrid());
    collapsedCats[cat] = !collapsedCats[cat];
    if (gridApi) {
      gridApi.setGridOption(
        "rowData",
        getDisplayRows(window.__HZDV_SYSTEM_SETTINGS || readCached())
      );
    }
  }

  function buildGrid(settings) {
    if (!gridEl || typeof agGrid === "undefined" || !agGrid.createGrid) {
      if (statusEl) {
        statusEl.textContent = "AG Grid 未加载";
        statusEl.className = "settings-status settings-status--err";
      }
      return;
    }
    var rowData = getDisplayRows(settings);
    var colDefs = [
      {
        headerName: "分类",
        field: "category",
        width: 118,
        minWidth: 100,
        resizable: true,
        editable: false,
        cellClass: "settings-cell-category",
        cellRenderer: function (p) {
          if (!p.data) return "";
          if (p.data.__group) {
            var open = !collapsedCats[p.data.category];
            return (
              '<span class="settings-group-toggle" data-cat="' +
              String(p.data.category).replace(/"/g, "&quot;") +
              '">' +
              (open ? "▼ " : "▶ ") +
              p.data.category +
              "</span>"
            );
          }
          return "";
        },
      },
      {
        headerName: "描述",
        field: "desc",
        flex: 1.5,
        minWidth: 160,
        resizable: true,
        cellClass: "settings-cell-desc",
        editable: false,
      },
      {
        headerName: "值",
        field: "value",
        flex: 0.9,
        minWidth: 88,
        resizable: true,
        editable: function (p) {
          return !!(p.data && !p.data.__group);
        },
        cellClass: "settings-cell-value",
        cellEditor: "agTextCellEditor",
        valueFormatter: function (p) {
          return p.value;
        },
        valueParser: function (p) {
          return p.newValue;
        },
      },
      {
        headerName: "单位",
        field: "unit",
        width: 64,
        minWidth: 52,
        resizable: true,
        cellClass: "settings-cell-unit",
        editable: false,
      },
    ];
    var gridOptions = {
      columnDefs: colDefs,
      rowData: rowData,
      rowHeight: 38,
      headerHeight: 32,
      domLayout: "normal",
      stopEditingWhenCellsLoseFocus: true,
      singleClickEdit: true,
      getRowId: function (p) {
        return String((p.data && p.data.field) || Math.random());
      },
      getRowClass: function (p) {
        return p.data && p.data.__group ? "settings-row-group" : null;
      },
      onCellClicked: function (ev) {
        if (ev.data && ev.data.__group) {
          toggleCategory(ev.data.category);
        }
      },
      onCellValueChanged: function () {
        if (!statusEl) return;
        statusEl.textContent = "";
        statusEl.className = "settings-status";
      },
    };
    if (gridApi) {
      gridApi.setGridOption("rowData", rowData);
    } else {
      gridApi = agGrid.createGrid(gridEl, gridOptions);
    }
  }

  function collectFromGrid() {
    if (!gridApi) return mergeSettings(null);
    var rows = [];
    gridApi.forEachNode(function (node) {
      if (node && node.data && !node.data.__group && node.data.field) {
        rows.push(node.data);
      }
    });
    // 折叠组里的叶子不在当前 rowData，用缓存/内存值补齐
    var base = mergeSettings(window.__HZDV_SYSTEM_SETTINGS || readCached());
    var raw = Object.assign({}, base);
    for (var i = 0; i < rows.length; i++) {
      raw[rows[i].field] = rows[i].value;
    }
    return {
      ocrPreviewChars: clampInt(raw.ocrPreviewChars, 500, 200000, DEFAULTS.ocrPreviewChars),
      ocrTextMaxPdf: clampInt(raw.ocrTextMaxPdf, 1000, 200000, DEFAULTS.ocrTextMaxPdf),
      ocrTextMaxImage: clampInt(raw.ocrTextMaxImage, 500, 100000, DEFAULTS.ocrTextMaxImage),
      ocrVisionMaxPages: clampInt(raw.ocrVisionMaxPages, 1, 20, DEFAULTS.ocrVisionMaxPages),
      pdfVisionMaxPages: clampInt(raw.pdfVisionMaxPages, 1, 20, DEFAULTS.pdfVisionMaxPages),
      pdfRenderDpi: clampInt(raw.pdfRenderDpi, 72, 200, DEFAULTS.pdfRenderDpi),
      ocrShowDevPreview: clampInt(raw.ocrShowDevPreview, 0, 1, DEFAULTS.ocrShowDevPreview),
      ocrSendToLlm: clampInt(raw.ocrSendToLlm, 0, 1, DEFAULTS.ocrSendToLlm),
      tavilyMaxResults: clampInt(raw.tavilyMaxResults, 1, 10, DEFAULTS.tavilyMaxResults),
      tavilySearchDepth: clampInt(raw.tavilySearchDepth, 0, 1, DEFAULTS.tavilySearchDepth),
      llmShowPipelineTrace: clampInt(
        raw.llmShowPipelineTrace,
        0,
        1,
        DEFAULTS.llmShowPipelineTrace
      ),
      llmForceFailGenerate: clampInt(
        raw.llmForceFailGenerate,
        0,
        1,
        DEFAULTS.llmForceFailGenerate
      ),
      llmRouteMode: clampInt(raw.llmRouteMode, 0, 1, DEFAULTS.llmRouteMode),
      asrMicMode: clampInt(
        raw.asrMicMode != null
          ? raw.asrMicMode
          : raw.asrVadLive === 0 || raw.asrVadLive === "0"
            ? 0
            : DEFAULTS.asrMicMode,
        0,
        2,
        DEFAULTS.asrMicMode
      ),
    };
  }

  function loadSettings() {
    if (statusEl) {
      statusEl.textContent = "加载中…";
      statusEl.className = "settings-status";
    }
    fetch("/api/user-settings?user_id=" + encodeURIComponent(SYSTEM_USER_ID), {
      cache: "no-store",
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.success && data.settings) {
          var s = applyLocal(data.settings);
          buildGrid(s);
          if (statusEl) {
            statusEl.textContent = "";
            statusEl.className = "settings-status";
          }
        } else {
          buildGrid(readCached());
          if (statusEl) {
            statusEl.textContent = "加载失败，使用默认/缓存";
            statusEl.className = "settings-status settings-status--err";
          }
        }
      })
      .catch(function () {
        buildGrid(readCached());
        if (statusEl) {
          statusEl.textContent = "加载失败，使用默认/缓存";
          statusEl.className = "settings-status settings-status--err";
        }
      });
  }

  function saveSettings(opts) {
    opts = opts || {};
    if (gridApi && typeof gridApi.stopEditing === "function") {
      try {
        gridApi.stopEditing();
      } catch (e) {}
    }
    var settings = collectFromGrid();
    if (statusEl && !opts.silent) {
      statusEl.textContent = "保存中…";
      statusEl.className = "settings-status";
    }
    return fetch("/api/user-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ user_id: SYSTEM_USER_ID, settings: settings }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.success) {
          applyLocal(data.settings || settings);
          if (statusEl) {
            statusEl.textContent = "已保存";
            statusEl.className = "settings-status settings-status--ok";
          }
          return true;
        }
        if (statusEl) {
          statusEl.textContent =
            "保存失败：" + (data && data.error ? data.error : "未知错误");
          statusEl.className = "settings-status settings-status--err";
        }
        return false;
      })
      .catch(function (err) {
        if (statusEl) {
          statusEl.textContent = "保存失败：" + String(err);
          statusEl.className = "settings-status settings-status--err";
        }
        return false;
      });
  }

  function openSystemSettingsModal() {
    if (!overlay) return;
    bodyOverflowPrev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.add("show");
    loadSettings();
  }

  function closeSystemSettingsModal() {
    if (!overlay) return;
    saveSettings({ silent: false }).then(function () {
      overlay.setAttribute("aria-hidden", "true");
      overlay.classList.remove("show");
      document.body.style.overflow = bodyOverflowPrev || "";
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", closeSystemSettingsModal);
  }
  if (overlay) {
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) closeSystemSettingsModal();
    });
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && overlay && overlay.classList.contains("show")) {
      closeSystemSettingsModal();
    }
  });

  var menuBtn = document.getElementById("topNavSystemSettings");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      openSystemSettingsModal();
    });
  }

  // 启动时拉一次缓存到内存（不弹窗）
  applyLocal(readCached());
  fetch("/api/user-settings?user_id=" + encodeURIComponent(SYSTEM_USER_ID), {
    cache: "no-store",
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (data && data.success && data.settings) applyLocal(data.settings);
    })
    .catch(function () {});

  window.openSystemSettingsModal = openSystemSettingsModal;
  window.closeSystemSettingsModal = closeSystemSettingsModal;
  window.getHzdvSystemSettings = function () {
    return mergeSettings(window.__HZDV_SYSTEM_SETTINGS || readCached());
  };
})();
