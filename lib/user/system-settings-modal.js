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
  };

  var PARAM_ROWS = [
    { field: "ocrPreviewChars", desc: "聊天区 OCR/PDF 预览字数", value: 4500, unit: "字符" },
    { field: "ocrTextMaxPdf", desc: "送 LLM 的 PDF 文本上限", value: 14000, unit: "字符" },
    { field: "ocrTextMaxImage", desc: "送 LLM 的图片 OCR 文本上限", value: 6000, unit: "字符" },
    { field: "ocrVisionMaxPages", desc: "对话附带复杂页渲图上限", value: 6, unit: "页" },
    { field: "pdfVisionMaxPages", desc: "OCR 服务复杂页渲图上限", value: 6, unit: "页" },
    { field: "pdfRenderDpi", desc: "PDF 整页渲图 DPI", value: 120, unit: "DPI" },
  ];

  var template =
    '<div class="settings-modal-overlay" id="settingsModalOverlay" aria-hidden="true">' +
    '<div class="settings-modal-sheet" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">' +
    '<button type="button" class="settings-modal-close" id="settingsModalCloseBtn" aria-label="关闭">&times;</button>' +
    '<h2 id="settingsModalTitle" class="settings-modal-title">系统参数设置</h2>' +
    '<div id="settingsGrid" class="ag-theme-quartz" style="height:280px;width:100%;"></div>' +
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

  function getRowData(settings) {
    var s = mergeSettings(settings);
    return PARAM_ROWS.map(function (r) {
      return {
        field: r.field,
        desc: r.desc,
        unit: r.unit,
        value: s[r.field] != null ? s[r.field] : r.value,
      };
    });
  }

  function buildGrid(settings) {
    if (!gridEl || typeof agGrid === "undefined" || !agGrid.createGrid) {
      if (statusEl) {
        statusEl.textContent = "AG Grid 未加载";
        statusEl.className = "settings-status settings-status--err";
      }
      return;
    }
    var rowData = getRowData(settings);
    var colDefs = [
      {
        headerName: "描述",
        field: "desc",
        flex: 1.4,
        minWidth: 160,
        resizable: true,
        cellClass: "settings-cell-desc",
        editable: false,
      },
      {
        headerName: "值",
        field: "value",
        flex: 1,
        minWidth: 100,
        resizable: true,
        editable: true,
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
        width: 72,
        minWidth: 56,
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
      if (node && node.data) rows.push(node.data);
    });
    var raw = {};
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
