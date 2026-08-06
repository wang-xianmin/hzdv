/**
 * AI 助手：顶栏入口 → 底部 agent → 紧凑对话窗口（含 Auto / LLM 选择，类似 Cursor）
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "hzdv_ai_assist_model";

  var PROMPTS_ZH = [
    "迪微是干什么的？",
    "迪微有什么产品？",
    "迪微能帮我进行系统集成吗？",
  ];
  var PROMPTS_EN = [
    "What does Diwei do?",
    "What products does Diwei offer?",
    "Can Diwei help with system integration?",
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

  /** 可调：聊天区 OCR/PDF 预览最多展示多少字符（只影响预览，不影响全量提取） */
  var OCR_PREVIEW_CHARS = 4500;
  /** 可调：预览里最多列多少行明细（图片 OCR） */
  var OCR_PREVIEW_LINES = 80;

  function getOcrSystemSettings() {
    return (
      (typeof window.getHzdvSystemSettings === "function" && window.getHzdvSystemSettings()) ||
      window.__HZDV_SYSTEM_SETTINGS ||
      null
    );
  }

  function syncOcrPreviewLimitsFromSystemSettings() {
    var s = getOcrSystemSettings();
    if (!s) return;
    var n = parseInt(s.ocrPreviewChars, 10);
    if (!isNaN(n) && n >= 500) OCR_PREVIEW_CHARS = n;
  }

  /** 1=聊天区显示 OCR 开发者预览；默认开 */
  function isOcrShowDevPreview() {
    var s = getOcrSystemSettings();
    if (!s || s.ocrShowDevPreview == null) return true;
    var n = parseInt(s.ocrShowDevPreview, 10);
    return n !== 0;
  }

  /** 1=OCR 随下一条消息送 LLM；默认开 */
  function isOcrSendToLlm() {
    var s = getOcrSystemSettings();
    if (!s || s.ocrSendToLlm == null) return true;
    var n = parseInt(s.ocrSendToLlm, 10);
    return n !== 0;
  }

  window.onHzdvSystemSettingsChange = function () {
    syncOcrPreviewLimitsFromSystemSettings();
    if (typeof refreshRouteLauncherHint === "function") {
      try {
        refreshRouteLauncherHint();
      } catch (eHint) {}
    }
  };
  syncOcrPreviewLimitsFromSystemSettings();

  /** 最近一次 OCR 结果，随下一条消息带给 /api/llm-chat 后清空 */
  var pendingOcr = null;
  /** 输入框附件：{ kind, name, file, previewUrl, ext } */
  var pendingAttachment = null;
  var ocrAbort = null;
  var asrAbort = null;
  var attachStrip = null;
  var lightboxEl = null;
  /** 麦克风录音状态：mode 0整段 / 1 VAD+SenseVoice / 2真流式 */
  var asrMic = {
    recording: false,
    stream: null,
    ctx: null,
    processor: null,
    source: null,
    chunks: [],
    sampleRate: 16000,
    btn: null,
    micMode: 1,
    /** VAD */
    vadMode: true,
    speechActive: false,
    silenceMs: 0,
    speechMs: 0,
    speechChunks: [],
    preroll: [],
    noiseEma: 0.008,
    seq: 0,
    nextApply: 1,
    pendingText: {},
    inFlight: 0,
    statusMsgIdx: null,
    /** 真流式 */
    streamSessionId: null,
    streamBusy: false,
    streamQueue: [],
    streamCommitted: [],
    streamPartial: "",
    inputPrefix: "",
    streamSendTimer: null,
    streamBuf: [],
  };

  var ASR_VAD = {
    /** 静音多久判定一句结束 */
    silenceCutMs: 700,
    /** 最短一句，过短丢弃 */
    minSpeechMs: 350,
    /** 强制切段，防止一句过长 */
    maxSpeechMs: 12000,
    /** 句首预留 */
    prerollMs: 280,
    /** 绝对能量下限（配合噪声底） */
    minSpeechRms: 0.012,
    /** 相对噪声倍数 */
    speechFactor: 2.6,
  };

  /** 0整段 / 1 VAD断句离线 / 2真流式（互斥） */
  function getAsrMicMode() {
    var s =
      (typeof window.getHzdvSystemSettings === "function" && window.getHzdvSystemSettings()) ||
      window.__HZDV_SYSTEM_SETTINGS ||
      null;
    if (s && s.asrMicMode != null) {
      var n = parseInt(s.asrMicMode, 10);
      if (n === 0 || n === 1 || n === 2) return n;
    }
    // 兼容旧 asrVadLive
    if (s && (s.asrVadLive === 0 || s.asrVadLive === "0" || s.asrVadLive === false)) {
      return 0;
    }
    return 1;
  }

  function isAsrVadLiveEnabled() {
    return getAsrMicMode() === 1;
  }

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

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf("audio/") === 0) return true;
    return /\.(wav|mp3|ogg|flac|m4a|webm|aac)$/i.test(String(file.name || ""));
  }

  function encodeWavMono(floatSamples, sampleRate) {
    var n = floatSamples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    var offset = 44;
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, floatSamples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function setMicRecordingUi(on) {
    var btn = asrMic.btn || document.getElementById("aiAssistMic");
    if (!btn) return;
    btn.classList.toggle("is-recording", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    var mode = asrMic.micMode;
    btn.setAttribute(
      "aria-label",
      on ? t("停止录音", "Stop recording") : t("语音", "Voice")
    );
    if (on) {
      if (mode === 2) {
        btn.title = t("真流式识别中，点击结束", "Streaming ASR; click to stop");
      } else if (mode === 1) {
        btn.title = t("点击结束（停顿会自动上屏）", "Click to stop (auto-transcribe on pause)");
      } else {
        btn.title = t("点击结束并识别", "Click to stop and transcribe");
      }
    } else {
      btn.title = t("语音", "Voice");
    }
  }

  function stopMicCapture() {
    try {
      if (asrMic.processor) {
        asrMic.processor.disconnect();
        asrMic.processor.onaudioprocess = null;
      }
    } catch (e1) {}
    try {
      if (asrMic.source) asrMic.source.disconnect();
    } catch (e2) {}
    try {
      if (asrMic.ctx && asrMic.ctx.state !== "closed") asrMic.ctx.close();
    } catch (e3) {}
    try {
      if (asrMic.stream) {
        asrMic.stream.getTracks().forEach(function (tr) {
          tr.stop();
        });
      }
    } catch (e4) {}
    asrMic.processor = null;
    asrMic.source = null;
    asrMic.ctx = null;
    asrMic.stream = null;
    asrMic.recording = false;
    asrMic.speechActive = false;
    asrMic.silenceMs = 0;
    asrMic.speechMs = 0;
    asrMic.speechChunks = [];
    asrMic.preroll = [];
    asrMic.chunks = [];
    asrMic.streamSessionId = null;
    asrMic.streamBusy = false;
    asrMic.streamQueue = [];
    asrMic.streamCommitted = [];
    asrMic.streamPartial = "";
    asrMic.inputPrefix = "";
    asrMic.streamBuf = [];
    if (asrMic.streamSendTimer) {
      clearInterval(asrMic.streamSendTimer);
      asrMic.streamSendTimer = null;
    }
    setMicRecordingUi(false);
  }

  function mergeFloatChunks(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], off);
      off += chunks[j].length;
    }
    return out;
  }

  function frameRms(samples) {
    if (!samples || !samples.length) return 0;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i];
      sum += v * v;
    }
    return Math.sqrt(sum / samples.length);
  }

  function asrReportText(data, en) {
    var text = String((data && data.text) || "").trim();
    var head = en
      ? "[Sherpa-onnx / SenseVoice]"
      : "【Sherpa-onnx / SenseVoice】";
    if (!text) {
      return head + (en ? "\n(no speech recognized)" : "\n（未识别到语音）");
    }
    return head + "\n" + text;
  }

  function applyAsrTextToInput(text) {
    if (!inputEl) return;
    var t0 = String(text || "").trim();
    if (!t0) return;
    var cur = String(inputEl.value || "").trim();
    inputEl.value = cur ? cur + " " + t0 : t0;
    try {
      inputEl.focus();
    } catch (e) {}
    syncSendState();
  }

  function setAsrLiveStatus(text) {
    var msg = String(text || "").trim();
    if (!msg) return;
    // 复用同一条助手提示，避免刷屏（messages / renderThread 在同 IIFE 内）
    try {
      if (
        asrMic.statusMsgIdx != null &&
        messages[asrMic.statusMsgIdx] &&
        messages[asrMic.statusMsgIdx].__asrLive
      ) {
        messages[asrMic.statusMsgIdx].text = msg;
        renderThread();
        return;
      }
      messages.push({
        role: "assistant",
        text: msg,
        model: selectedModelId,
        __asrLive: true,
      });
      asrMic.statusMsgIdx = messages.length - 1;
      renderThread();
    } catch (e) {
      try {
        appendAssistant(msg);
      } catch (e2) {}
    }
  }

  function flushOrderedAsrText() {
    while (asrMic.pendingText[asrMic.nextApply] != null) {
      var piece = asrMic.pendingText[asrMic.nextApply];
      delete asrMic.pendingText[asrMic.nextApply];
      asrMic.nextApply += 1;
      if (piece) applyAsrTextToInput(piece);
    }
  }

  function float32ToBase64(samples) {
    var buf = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );
    var bytes = new Uint8Array(buf);
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunk, bytes.length))
      );
    }
    return btoa(bin);
  }

  function resampleLinear(samples, fromSr, toSr) {
    if (fromSr === toSr) return samples;
    var n = Math.max(1, Math.round((samples.length * toSr) / fromSr));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * (samples.length - 1)) / Math.max(1, n - 1);
      var i0 = Math.floor(x);
      var i1 = Math.min(samples.length - 1, i0 + 1);
      var t = x - i0;
      out[i] = samples[i0] * (1 - t) + samples[i1] * t;
    }
    return out;
  }

  function paintStreamInput() {
    if (!inputEl) return;
    var prefix = asrMic.inputPrefix || "";
    var parts = (asrMic.streamCommitted || []).filter(Boolean);
    if (asrMic.streamPartial) parts = parts.concat([asrMic.streamPartial]);
    var body = parts.join(" ").trim();
    if (prefix && body) inputEl.value = prefix + " " + body;
    else inputEl.value = prefix || body || "";
    syncSendState();
  }

  function postAsrStream(body) {
    return fetch("/api/asr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data || {} };
      });
    });
  }

  function drainStreamQueue() {
    if (asrMic.streamBusy) return;
    if (!asrMic.streamQueue.length) return;
    asrMic.streamBusy = true;
    var job = asrMic.streamQueue.shift();
    postAsrStream(job.body)
      .then(function (pack) {
        asrMic.streamBusy = false;
        if (job.onDone) job.onDone(pack);
        drainStreamQueue();
      })
      .catch(function (err) {
        asrMic.streamBusy = false;
        if (job.onDone) job.onDone({ ok: false, data: { error: String(err) } });
        drainStreamQueue();
      });
  }

  function enqueueStream(body, onDone) {
    asrMic.streamQueue.push({ body: body, onDone: onDone });
    drainStreamQueue();
  }

  function flushStreamAudioBuf(force) {
    if (asrMic.micMode !== 2) return;
    if (!force && !asrMic.recording) return;
    if (!asrMic.streamSessionId) return;
    if (!asrMic.streamBuf.length) return;
    var samples = mergeFloatChunks(asrMic.streamBuf);
    asrMic.streamBuf = [];
    if (!samples.length) return;
    var pcm16k = resampleLinear(samples, asrMic.sampleRate || 48000, 16000);
    enqueueStream(
      {
        action: "audio",
        sessionId: asrMic.streamSessionId,
        pcm: float32ToBase64(pcm16k),
        sampleRate: 16000,
        dtype: "float32",
      },
      function (pack) {
        if (!pack || !pack.ok || pack.data.success === false) {
          setAsrLiveStatus(
            t("真流式识别失败：", "Streaming ASR failed: ") +
              ((pack && pack.data && (pack.data.error || pack.data.detail)) ||
                "unknown")
          );
          return;
        }
        var d = pack.data;
        if (Array.isArray(d.committed)) asrMic.streamCommitted = d.committed.slice();
        if (d.final) {
          asrMic.streamPartial = "";
        } else {
          asrMic.streamPartial = String(d.partial || "").trim();
        }
        paintStreamInput();
      }
    );
  }

  function startStreamingSession(done) {
    postAsrStream({ action: "start" })
      .then(function (pack) {
        if (!pack.ok || pack.data.success === false || !pack.data.sessionId) {
          done(
            new Error(
              (pack.data && (pack.data.error || pack.data.detail)) ||
                "无法启动真流式会话"
            )
          );
          return;
        }
        asrMic.streamSessionId = pack.data.sessionId;
        asrMic.streamCommitted = [];
        asrMic.streamPartial = "";
        done(null);
      })
      .catch(function (err) {
        done(err);
      });
  }

  function endStreamingSession(cb) {
    flushStreamAudioBuf(true);
    var sid = asrMic.streamSessionId;
    if (!sid) {
      if (cb) cb();
      return;
    }
    function tryEnd() {
      if (asrMic.streamBusy || asrMic.streamQueue.length) {
        setTimeout(tryEnd, 80);
        return;
      }
      enqueueStream({ action: "end", sessionId: sid }, function (pack) {
        asrMic.streamSessionId = null;
        if (pack && pack.ok && pack.data) {
          if (Array.isArray(pack.data.committed)) {
            asrMic.streamCommitted = pack.data.committed.slice();
          }
          asrMic.streamPartial = "";
          paintStreamInput();
        }
        if (cb) cb();
      });
    }
    tryEnd();
  }

  function runAsrBlob(blob, filename, opts) {
    opts = opts || {};
    if (!blob) return Promise.resolve(null);
    var live = !!opts.live;
    var seq = opts.seq || 0;
    if (!live) {
      if (asrAbort) {
        try {
          asrAbort.abort();
        } catch (e) {}
      }
      asrAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    }
    var fd = new FormData();
    fd.append("file", blob, filename || "speech.wav");
    if (!live) {
      appendAssistant(t("正在识别语音…", "Transcribing speech…"));
    } else {
      asrMic.inFlight += 1;
      setAsrLiveStatus(
        t(
          "正在听… 已断句识别中（" + asrMic.inFlight + "）",
          "Listening… transcribing segment (" + asrMic.inFlight + ")"
        )
      );
    }
    var ctrl = live
      ? typeof AbortController !== "undefined"
        ? new AbortController()
        : null
      : asrAbort;
    return fetch("/api/asr", {
      method: "POST",
      body: fd,
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (pack) {
        var data = pack.data || {};
        if (!pack.ok || data.success === false) {
          if (live) {
            setAsrLiveStatus(
              t("语音识别失败：", "Speech recognition failed: ") +
                (data.error || data.detail || "unknown")
            );
          } else {
            appendAssistant(
              t("语音识别失败：", "Speech recognition failed: ") +
                (data.error || data.detail || "unknown")
            );
          }
          return null;
        }
        var text = String(data.text || "").trim();
        if (live) {
          asrMic.pendingText[seq] = text;
          flushOrderedAsrText();
          return text;
        }
        var en = currentLang() === "en";
        appendAssistant(asrReportText(data, en), {
          modelBadge: "Sherpa-onnx",
          modelNote: en
            ? "Text filled into the input box."
            : "已填入输入框，可继续编辑后发送。",
          mono: true,
        });
        applyAsrTextToInput(text);
        return text;
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return null;
        var msg =
          t("语音识别网络异常：", "Speech recognition network error: ") +
          String((err && err.message) || err || "");
        if (live) setAsrLiveStatus(msg);
        else appendAssistant(msg);
        return null;
      })
      .then(function (text) {
        if (live) {
          asrMic.inFlight = Math.max(0, asrMic.inFlight - 1);
          if (asrMic.recording) {
            setAsrLiveStatus(
              asrMic.inFlight > 0
                ? t(
                    "正在听… 已断句识别中（" + asrMic.inFlight + "）",
                    "Listening… transcribing segment (" + asrMic.inFlight + ")"
                  )
                : t(
                    "正在听… 停顿后自动上屏，再点麦克风结束",
                    "Listening… auto-fill on pause; click mic to stop"
                  )
            );
          } else if (asrMic.inFlight === 0) {
            setAsrLiveStatus(
              t("录音结束，识别结果已写入输入框", "Recording ended; text is in the input")
            );
          }
        }
        return text;
      });
  }

  function emitVadSegment(force) {
    var chunks = asrMic.speechChunks;
    asrMic.speechChunks = [];
    asrMic.speechActive = false;
    asrMic.silenceMs = 0;
    asrMic.speechMs = 0;
    if (!chunks || !chunks.length) return;
    var sr = asrMic.sampleRate || 48000;
    var samples = mergeFloatChunks(chunks);
    var minSamples = Math.floor((sr * ASR_VAD.minSpeechMs) / 1000);
    if (!force && samples.length < minSamples) return;
    if (samples.length < Math.floor(sr * 0.12)) return;
    asrMic.seq += 1;
    var seq = asrMic.seq;
    var blob = encodeWavMono(samples, sr);
    runAsrBlob(blob, "vad-" + seq + "-" + Date.now() + ".wav", {
      live: true,
      seq: seq,
    });
  }

  function onVadAudioFrame(input) {
    if (!asrMic.recording || !asrMic.vadMode) return;
    var sr = asrMic.sampleRate || 48000;
    var frame = new Float32Array(input);
    var ms = (frame.length / sr) * 1000;
    var rms = frameRms(frame);
    var thr = Math.max(ASR_VAD.minSpeechRms, asrMic.noiseEma * ASR_VAD.speechFactor);
    var isSpeech = rms >= thr;

    if (!isSpeech) {
      // 更新噪声底（仅在非语音时）
      asrMic.noiseEma = asrMic.noiseEma * 0.95 + rms * 0.05;
      // 预留句首
      asrMic.preroll.push(frame);
      var prerollMax = Math.max(1, Math.ceil((ASR_VAD.prerollMs / 1000) * sr / frame.length));
      while (asrMic.preroll.length > prerollMax) asrMic.preroll.shift();
    }

    if (!asrMic.speechActive) {
      if (isSpeech) {
        asrMic.speechActive = true;
        asrMic.silenceMs = 0;
        asrMic.speechMs = 0;
        asrMic.speechChunks = asrMic.preroll.slice();
        asrMic.preroll = [];
        asrMic.speechChunks.push(frame);
        asrMic.speechMs += ms;
      }
      return;
    }

    asrMic.speechChunks.push(frame);
    if (isSpeech) {
      asrMic.silenceMs = 0;
      asrMic.speechMs += ms;
    } else {
      asrMic.silenceMs += ms;
      asrMic.speechMs += ms;
    }

    if (asrMic.silenceMs >= ASR_VAD.silenceCutMs) {
      emitVadSegment(false);
      return;
    }
    if (asrMic.speechMs >= ASR_VAD.maxSpeechMs) {
      emitVadSegment(true);
    }
  }

  function startMicRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      appendAssistant(
        t(
          "当前浏览器不支持麦克风录音。",
          "This browser does not support microphone recording."
        )
      );
      return;
    }
    var mode = getAsrMicMode();
    asrMic.micMode = mode;
    asrMic.vadMode = mode === 1;

    function beginCapture() {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) {
            stream.getTracks().forEach(function (tr) {
              tr.stop();
            });
            appendAssistant(
              t("当前浏览器不支持 AudioContext。", "AudioContext is not supported.")
            );
            return;
          }
          var ctx = new Ctx();
          var source = ctx.createMediaStreamSource(stream);
          var processor = ctx.createScriptProcessor(4096, 1, 1);
          asrMic.stream = stream;
          asrMic.ctx = ctx;
          asrMic.source = source;
          asrMic.processor = processor;
          asrMic.chunks = [];
          asrMic.sampleRate = ctx.sampleRate || 48000;
          asrMic.speechActive = false;
          asrMic.silenceMs = 0;
          asrMic.speechMs = 0;
          asrMic.speechChunks = [];
          asrMic.preroll = [];
          asrMic.noiseEma = 0.008;
          asrMic.seq = 0;
          asrMic.nextApply = 1;
          asrMic.pendingText = {};
          asrMic.inFlight = 0;
          asrMic.statusMsgIdx = null;
          asrMic.streamBuf = [];
          asrMic.inputPrefix = inputEl ? String(inputEl.value || "").trim() : "";
          asrMic.recording = true;
          setMicRecordingUi(true);
          if (mode === 2) {
            setAsrLiveStatus(
              t(
                "SenseVoice 流式识别中… 边说边上屏，再点麦克风结束",
                "SenseVoice streaming… text appears live; click mic to stop"
              )
            );
            asrMic.streamSendTimer = setInterval(flushStreamAudioBuf, 280);
          } else if (mode === 1) {
            setAsrLiveStatus(
              t(
                "正在听… 停顿后自动上屏，再点麦克风结束",
                "Listening… auto-fill on pause; click mic to stop"
              )
            );
          }
          processor.onaudioprocess = function (ev) {
            if (!asrMic.recording) return;
            var input = ev.inputBuffer.getChannelData(0);
            if (asrMic.micMode === 2) {
              asrMic.streamBuf.push(new Float32Array(input));
            } else if (asrMic.vadMode) {
              onVadAudioFrame(input);
            } else {
              asrMic.chunks.push(new Float32Array(input));
            }
          };
          var mute = ctx.createGain();
          mute.gain.value = 0;
          source.connect(processor);
          processor.connect(mute);
          mute.connect(ctx.destination);
        })
        .catch(function (err) {
          appendAssistant(
            t("无法打开麦克风：", "Cannot open microphone: ") +
              String((err && err.message) || err || "")
          );
        });
    }

    if (mode === 2) {
      startStreamingSession(function (err) {
        if (err) {
          appendAssistant(
            t("无法启动真流式：", "Cannot start streaming ASR: ") +
              String((err && err.message) || err || "") +
              t(
                "（请确认 VPS 已 ./download_models.sh streaming 并重启容器）",
                " (ensure VPS ran download_models.sh streaming and restarted)"
              )
          );
          return;
        }
        beginCapture();
      });
      return;
    }
    beginCapture();
  }

  function finishMicRecording() {
    if (!asrMic.recording) return;
    var mode = asrMic.micMode;

    if (mode === 2) {
      asrMic.recording = false;
      setMicRecordingUi(false);
      if (asrMic.streamSendTimer) {
        clearInterval(asrMic.streamSendTimer);
        asrMic.streamSendTimer = null;
      }
      // 先停采集，再冲刷流式会话（保留 sessionId）
      try {
        if (asrMic.processor) {
          asrMic.processor.disconnect();
          asrMic.processor.onaudioprocess = null;
        }
      } catch (e1) {}
      try {
        if (asrMic.source) asrMic.source.disconnect();
      } catch (e2) {}
      try {
        if (asrMic.ctx && asrMic.ctx.state !== "closed") asrMic.ctx.close();
      } catch (e3) {}
      try {
        if (asrMic.stream) {
          asrMic.stream.getTracks().forEach(function (tr) {
            tr.stop();
          });
        }
      } catch (e4) {}
      asrMic.processor = null;
      asrMic.source = null;
      asrMic.ctx = null;
      asrMic.stream = null;
      endStreamingSession(function () {
        setAsrLiveStatus(
          t(
            "真流式结束，文字已写入输入框",
            "Streaming ended; text is in the input"
          )
        );
      });
      return;
    }

    if (mode === 1) {
      if (asrMic.speechActive) emitVadSegment(true);
      stopMicCapture();
      if (asrMic.inFlight === 0 && asrMic.seq === 0) {
        setAsrLiveStatus(t("没有录到有效语音。", "No speech captured."));
      } else if (asrMic.inFlight === 0) {
        setAsrLiveStatus(
          t("录音结束，识别结果已写入输入框", "Recording ended; text is in the input")
        );
      }
      return;
    }

    var chunks = asrMic.chunks.slice();
    var sr = asrMic.sampleRate || 48000;
    stopMicCapture();
    if (!chunks.length) {
      appendAssistant(t("没有录到声音。", "No audio captured."));
      return;
    }
    var samples = mergeFloatChunks(chunks);
    if (samples.length < sr * 0.2) {
      appendAssistant(
        t("录音太短，请再说久一点。", "Recording too short. Please speak longer.")
      );
      return;
    }
    var blob = encodeWavMono(samples, sr);
    runAsrBlob(blob, "mic-" + Date.now() + ".wav");
  }

  function toggleMicRecording() {
    if (asrMic.recording) finishMicRecording();
    else startMicRecording();
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
        ? t("PDF 已提取，下一条将送 LLM", "PDF extracted — next message → LLM")
        : t("OCR 已完成，下一条将送 LLM", "OCR done — next message → LLM");
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

    if (isAudioFile(file)) {
      runAsrBlob(file, file.name || "audio.wav");
      return;
    }

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
          (data.line_count || 0) +
          (data.table_count != null
            ? " · " + (en ? "tables " : "表格 ") + data.table_count
            : "") +
          (data.engine ? " · engine " + data.engine : "")
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
      out.push(
        en
          ? "(Tables: merged cells expanded; multi-line cells joined. Flat LLM form under [表格·扁平·供LLM].)"
          : "（表格已展开合并单元格、拼接格内多行；扁平版见 [表格·扁平·供LLM]）"
      );
      out.push(String(data.text).slice(0, OCR_PREVIEW_CHARS));
      if (String(data.text).length > OCR_PREVIEW_CHARS) {
        out.push(en ? "\n… truncated" : "\n… 已截断");
      }
      return out.join("\n");
    }

    var llmText = String(data.text_llm || data.text || "").trim();
    out.push(en ? "\nText for LLM:" : "\n送模文本：");
    out.push(llmText.slice(0, OCR_PREVIEW_CHARS));
    if (llmText.length > OCR_PREVIEW_CHARS) {
      out.push(en ? "\n… truncated" : "\n… 已截断");
    }

    out.push(en ? "\nLines (debug · conf · box):" : "\n逐行明细（调试 · 置信 · 坐标）：");
    lines.slice(0, OCR_PREVIEW_LINES).forEach(function (ln, i) {
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
    if (lines.length > OCR_PREVIEW_LINES) {
      out.push(
        en
          ? "… " + (lines.length - OCR_PREVIEW_LINES) + " more lines"
          : "… 另有 " + (lines.length - OCR_PREVIEW_LINES) + " 行"
      );
    }
    return out.join("\n");
  }

  function ocrRoutingNote(data, en) {
    var lay = data.layout || {};
    var isPdf = data.source === "pdf";
    var visionPages = (lay.vision_pages || []).slice();
    if (!visionPages.length && Array.isArray(data.pages)) {
      data.pages.forEach(function (p) {
        if (p && p.image_base64) visionPages.push(p.page);
      });
    }
    var hasText = !!String(data.text_llm || data.text || "").trim();
    var hasVision = visionPages.length > 0;
    if (!hasText && !hasVision) {
      return isPdf
        ? en
          ? "No extractable text and no page render. Not ready for LLM."
          : "未提取到文字且未能渲图。尚不能送 LLM。"
        : en
          ? "No text recognized. Not ready for LLM."
          : "未识别到文字。尚不能送 LLM。";
    }
    var floor =
      " tier" +
      (lay.suggested_tier || "?") +
      ((lay.reasons || []).length ? " (" + (lay.reasons || []).join(", ") + ")" : "");
    var floorZh =
      " tier" +
      (lay.suggested_tier || "?") +
      ((lay.reasons || []).length ? "（" + (lay.reasons || []).join("、") + "）" : "");
    if (isPdf) {
      return en
        ? "PDF extracted — simple pages as text, complex pages as full-page images. " +
            "Next message: doc + your question → intent classifier (tier2 / tier3, vision optional)." +
            (hasVision ? " Rendered pages: " + visionPages.join(", ") + "." : "")
        : "PDF 已提取——简单页文本，复杂页整页渲图。" +
            " 下一条：文档+你的问题 → 意图分类（可走第 2 梯队，或无视觉的第 3 梯队）。" +
            (hasVision ? " 已渲图页：" + visionPages.join("、") + "。" : "");
    }
    return en
      ? "Image OCR ready for next message. Floor:" + floor
      : "图片 OCR 已就绪，下一条消息会送 LLM。建议下限：" + floorZh;
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
        var textLlm = String(data.text_llm || data.text || "").trim();
        var en = currentLang() === "en";
        var visionPages = [];
        if (Array.isArray(data.pages)) {
          data.pages.forEach(function (p) {
            if (!p || !p.image_base64) return;
            visionPages.push({
              page: p.page,
              image_base64: p.image_base64,
              image_mime: p.image_mime || "image/jpeg",
              needs_vision: true,
            });
          });
        }
        var sendToLlm = isOcrSendToLlm();
        var showDev = isOcrShowDevPreview();
        pendingOcr = null;
        if (sendToLlm) {
          pendingOcr = {
            text: text,
            text_llm: textLlm || text,
            line_count: data.line_count || 0,
            layout: data.layout || null,
            source: data.source || (data.page_count != null ? "pdf" : "image"),
            page_count: data.page_count || null,
            pages: visionPages,
          };
          if (!textLlm && !text && !visionPages.length) pendingOcr = null;
        }
        pendingAttachment.ocrStatus = "done";
        renderAttachment();
        var isPdf = (data.source || pendingAttachment.kind) === "pdf";
        var engine = data.engine ? String(data.engine) : isPdf ? "pdfplumber" : "";
        var badge = isPdf
          ? "PDF · " + (engine || "pdfplumber")
          : "RapidOCR + ONNX Runtime";
        if (showDev) {
          appendAssistant(ocrReportText(data, en), {
            modelBadge: badge,
            modelNote: sendToLlm
              ? ocrRoutingNote(data, en)
              : en
                ? "Dev preview only — not attached for next LLM message."
                : "仅开发者预览——不会随下一条消息送 LLM。",
            mono: true,
          });
        } else if (sendToLlm && pendingOcr) {
          appendAssistant(
            en
              ? "[OCR ready · LLM only]\nResult will ride with your next message. Dev preview is off in System settings."
              : "【OCR 已就绪 · 仅送 LLM】\n结果会随你的下一条消息送模型。开发者预览已在系统设置中关闭。",
            {
              modelBadge: badge,
              modelNote: ocrRoutingNote(data, en),
              mono: true,
            }
          );
        } else if (!sendToLlm) {
          appendAssistant(
            en
              ? "[OCR done]\nNot shown in chat and not sent to LLM (both toggles off / send off)."
              : "【OCR 完成】\n未在聊天区展开，也未送 LLM（请在系统设置「OCR输出」调整）。",
            { modelBadge: badge, mono: true }
          );
        }
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
    asrMic.btn = root.querySelector("#aiAssistMic");
    if (asrMic.btn) {
      asrMic.btn.addEventListener("click", function () {
        toggleMicRecording();
      });
    }

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept =
      "image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.pdf,.txt,.md,.doc,.docx,.csv,audio/*,.wav,.mp3,.ogg,.flac,.m4a,.webm";
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
      hintEl.textContent = t("…", "…");
    }
    refreshRouteLauncherHint();
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

  /** 启动气泡副标题：如「自动·CN」（点 AI助手 即可看见，无需先对话） */
  var routeHintSeq = 0;
  function refreshRouteLauncherHint() {
    if (!root) return;
    var hintEl = root.querySelector("#aiAssistAgentHint");
    if (!hintEl) return;
    var seq = ++routeHintSeq;
    var ss = null;
    if (typeof window.getHzdvSystemSettings === "function") {
      try {
        ss = window.getHzdvSystemSettings();
      } catch (eSys) {
        ss = null;
      }
    }
    fetch("/api/llm-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        lang: currentLang(),
        systemSettings: ss || {},
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (seq !== routeHintSeq) return;
        if (j && j.success && j.launcherHint) {
          hintEl.textContent = j.launcherHint;
        } else {
          hintEl.textContent = t("点我开始对话", "Tap to start chatting");
        }
      })
      .catch(function () {
        if (seq !== routeHintSeq) return;
        hintEl.textContent = t("点我开始对话", "Tap to start chatting");
      });
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

  function wantPipelineTrace() {
    try {
      var ss =
        (typeof window.getHzdvSystemSettings === "function" &&
          window.getHzdvSystemSettings()) ||
        window.__HZDV_SYSTEM_SETTINGS ||
        null;
      return !!(ss && Number(ss.llmShowPipelineTrace) === 1);
    } catch (e) {
      return false;
    }
  }

  function wantForceFailGenerate() {
    try {
      var ss =
        (typeof window.getHzdvSystemSettings === "function" &&
          window.getHzdvSystemSettings()) ||
        window.__HZDV_SYSTEM_SETTINGS ||
        null;
      return !!(ss && Number(ss.llmForceFailGenerate) === 1);
    } catch (e) {
      return false;
    }
  }

  function formatPipelineNote(j) {
    if (!wantPipelineTrace()) return "";
    var lines = [];
    var notes = Array.isArray(j && j.notes) ? j.notes : [];
    notes.forEach(function (n, i) {
      if (!n) return;
      lines.push(i + 1 + ". " + String(n));
    });
    var attempts = Array.isArray(j && j.attempts) ? j.attempts : [];
    attempts.forEach(function (a) {
      if (!a) return;
      var mark = a.ok ? "✓" : "✗";
      var label = a.label || a.modelId || "?";
      var ms = a.latencyMs != null ? a.latencyMs + "ms" : "";
      var err = !a.ok && a.error ? " — " + a.error : "";
      var vision = a.usedVision ? t(" · 视觉", " · vision") : "";
      lines.push(
        "→ " + mark + " " + label + (ms ? " · " + ms : "") + vision + err
      );
    });
    return lines.join("\n");
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

  /**
   * 短期记忆：取当前提问之前的最近对话（不含本轮思考中气泡）。
   * @returns {{role:string,content:string}[]}
   */
  function buildChatHistory(currentQuestion) {
    var maxTurns = 8;
    var maxPer = 500;
    var out = [];
    var end = messages.length;
    // 去掉末尾「思考中…」助手气泡
    if (
      end > 0 &&
      messages[end - 1] &&
      messages[end - 1].role === "assistant" &&
      /^思考中|^Thinking/i.test(String(messages[end - 1].text || ""))
    ) {
      end -= 1;
    }
    // 去掉刚追加的本轮用户句
    if (
      end > 0 &&
      messages[end - 1] &&
      messages[end - 1].role === "user" &&
      String(messages[end - 1].text || "").trim() ===
        String(currentQuestion || "").trim()
    ) {
      end -= 1;
    }
    for (var i = 0; i < end; i++) {
      var m = messages[i];
      if (!m) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.__asrLive) continue;
      var text = String(m.text || "").trim();
      if (!text) continue;
      if (/^思考中|^Thinking/i.test(text)) continue;
      if (/^你好，我是 HZDV|^Hi there, you’re speaking with HZDV/i.test(text)) {
        continue;
      }
      out.push({
        role: m.role,
        content: text.slice(0, maxPer),
      });
    }
    if (out.length > maxTurns) out = out.slice(-maxTurns);
    return out;
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
    var catalogPromise = searchCatalogForShowcase(q);
    var ocrPayload = pendingOcr;
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

    appendAssistant(t("思考中…1.", "Thinking…1."), {
      modelBadge: want === "auto" ? "Auto · 1" : formatModelBadge(null, want),
    });
    var thinkingIdx = messages.length - 1;
    var thinkMajor = 1;
    var thinkMinor = 0;
    var thinkPulseTimer = null;

    function clearThinkPulse() {
      if (thinkPulseTimer) {
        clearInterval(thinkPulseTimer);
        thinkPulseTimer = null;
      }
    }

    /**
     * 气泡正文始终显示步骤编号：思考中…1. / 思考中…3.2（约 0.7s 跳动）。
     * 打开流水线跟踪时，verbose 阶段说明写入 modelNote，与编号并存。
     */
    function setThinkingBusy(major, opts) {
      opts = opts || {};
      clearThinkPulse();
      thinkMajor = Math.max(1, Number(major) || 1);
      thinkMinor = Math.max(0, Math.floor(Number(opts.minor) || 0));
      var verbose = opts.verbose || "";
      var badge = opts.badge || "";

      if (wantPipelineTrace() && verbose) {
        var prev = messages[thinkingIdx].modelNote || "";
        var stageLine = "· " + verbose;
        if (!prev) {
          messages[thinkingIdx].modelNote = stageLine;
        } else if (prev.indexOf(stageLine) === -1) {
          messages[thinkingIdx].modelNote = stageLine + "\n" + prev;
        }
      }

      function paint() {
        var base = t("思考中…", "Thinking…");
        messages[thinkingIdx].text =
          thinkMinor > 0
            ? base + thinkMajor + "." + thinkMinor
            : base + thinkMajor + ".";
        messages[thinkingIdx].modelBadge =
          badge ||
          (want === "auto"
            ? "Auto · " +
              thinkMajor +
              (thinkMinor > 0 ? "." + thinkMinor : "")
            : formatModelBadge(null, want) || "LLM");
        renderThread();
      }

      paint();
      thinkPulseTimer = setInterval(function () {
        thinkMinor += 1;
        if (thinkMinor > 99) thinkMinor = 1;
        paint();
      }, 700);
    }

    setThinkingBusy(want === "auto" ? 1 : 3, {
      verbose:
        want === "auto"
          ? t("① 正在意图分类…", "① Classifying intent…")
          : t("正在生成回答…", "Generating answer…"),
      badge:
        want === "auto"
          ? "Auto · ①意图"
          : formatModelBadge(null, want),
    });

    var reqBody = {
      phone: phone,
      message: q,
      modelId: want,
      lang: currentLang(),
      history: buildChatHistory(q),
    };
    if (ocrPayload) reqBody.ocr = ocrPayload;
    if (typeof window.getHzdvSystemSettings === "function") {
      try {
        reqBody.systemSettings = window.getHzdvSystemSettings();
      } catch (eSys) {}
    }

    function parseLlmResponse(r) {
      return r.text().then(function (text) {
        var j = null;
        var status = r.status || 0;
        if (text) {
          try {
            j = JSON.parse(text);
          } catch (eParse) {
            var snip = String(text).replace(/\s+/g, " ").trim().slice(0, 180);
            var cfHint =
              /<!DOCTYPE|cloudflare|attention required/i.test(text) ||
              status === 502 ||
              status === 504 ||
              status === 524;
            return {
              ok: false,
              status: status,
              j: {
                success: false,
                error: cfHint
                  ? t(
                      "Cloudflare 网关超时/失败（HTTP " +
                        status +
                        "）。本段是生成阶段（LLM）；意图/搜网若已成功会留在跟踪里。",
                      "Cloudflare gateway timeout/fail (HTTP " +
                        status +
                        "). This is the generate (LLM) phase; prior intent/web notes should remain."
                    )
                  : t("服务返回非 JSON（HTTP ", "Non-JSON response (HTTP ") +
                    status +
                    (snip ? "）：" + snip : "）"),
                wallClockFail: !!cfHint,
              },
            };
          }
        } else if (!r.ok || status === 204) {
          return {
            ok: false,
            status: status,
            j: {
              success: false,
              error: t("空响应 HTTP ", "Empty response HTTP ") + status,
              wallClockFail: status === 502 || status === 504 || status === 524,
            },
          };
        }
        if (j && typeof j === "object") {
          var err = String(j.error || "");
          if (
            !j.wallClockFail &&
            (/Cloudflare|HTML 502|剩余时间不够|Stopped before Cloudflare|gateway timeout|硬超时|Hard timeout/i.test(
              err
            ) ||
              status === 502 ||
              status === 504 ||
              status === 524)
          ) {
            j.wallClockFail = true;
          }
        }
        return { ok: r.ok, status: status, j: j || {} };
      });
    }

    /** 是否触发失败恢复编排（502 / 软超时）；每轮对话最多自动恢复一次 */
    function isWallClockFail(pack) {
      if (!pack) return false;
      var j = pack.j || {};
      if (pack.ok && j.success && j.reply) return false;
      if (j.wallClockFail) return true;
      var st = pack.status || 0;
      if (st === 502 || st === 504 || st === 524) return true;
      var err = String(j.error || "");
      return /Cloudflare|HTML 502|剩余时间不够|Stopped before Cloudflare|gateway timeout|硬超时|Hard timeout/i.test(
        err
      );
    }

    /** 墙钟失败时给用户的可读提示（技术细节仍可进跟踪） */
    function wallClockUserHint() {
      return t(
        "这个问题偏复杂，一次生成超时了。请拆成若干个更小的问题分别提问（例如先问一部分，确认后再问下一部分）。",
        "This question is too complex for one pass (generate timed out). Please split it into a few smaller questions and ask them one by one."
      );
    }

    function applyAssistantPack(pack, notePrefix) {
      clearThinkPulse();
      var j = pack.j || {};
      var badge = formatModelBadge(j.model, want);
      var latency = j.latencyMs != null ? " · " + j.latencyMs + "ms" : "";
      var note = formatPipelineNote(j);
      if (notePrefix && note) note = notePrefix + "\n" + note;
      else if (notePrefix) note = notePrefix;
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
        if (!errText && j.upstreamStatus) errText = "HTTP " + j.upstreamStatus;
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
        var wall = isWallClockFail(pack) || !!j.wallClockFail;
        var userText = wall
          ? wallClockUserHint()
          : t("调用失败：", "Failed: ") + errText;
        if (wall && errText && wantPipelineTrace()) {
          note = (note ? note + "\n" : "") + t("细节：", "Detail: ") + errText;
        }
        messages[thinkingIdx] = {
          role: "assistant",
          text: userText,
          model: want,
          modelBadge: (badge || "LLM") + latency,
          modelNote: note || messages[thinkingIdx].modelNote || "",
          modelMeta: j.model || null,
        };
      }
      renderThread();
    }

    function postJson(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      }).then(parseLlmResponse);
    }

    /** Auto：intent →（如需）websearch → llm-chat；墙钟失败则恢复编排一次 */
    function mergeNotes() {
      var out = [];
      for (var i = 0; i < arguments.length; i++) {
        var arr = arguments[i];
        if (!Array.isArray(arr)) continue;
        arr.forEach(function (n) {
          if (n && out.indexOf(n) === -1) out.push(n);
        });
      }
      return out;
    }

    function runRecoverPlan(ctx) {
      var intentObj = ctx.intentObj || null;
      var webCtx = ctx.webCtx || "";
      var allNotes = ctx.allNotes || [];
      var failReason = ctx.failReason || "";
      var failStatus = ctx.failStatus || 0;

      setThinkingBusy(4, {
        verbose: t(
          "检测到超时，正在尝试自动拆步；若仍失败，请把问题拆成更小的几问…",
          "Timeout detected — trying auto split; if it still fails, please ask smaller questions…"
        ),
        badge: "Auto · 恢复",
      });

      // 打点可失败忽略
      var logP = postJson("/api/llm-recover-log", {
        phone: reqBody.phone,
        reason: failReason,
        phase: "generate",
        status: failStatus,
        messageSnippet: String(reqBody.message || "").slice(0, 120),
      }).catch(function () {
        return null;
      });

      return logP
        .then(function () {
          setThinkingBusy(4, {
            verbose: t(
              "恢复：正在规划分步…",
              "Recovery: planning steps…"
            ),
            badge: "Auto · 规划",
          });
          return postJson("/api/llm-plan", {
            phone: reqBody.phone,
            message: reqBody.message,
            lang: reqBody.lang,
            failReason: failReason,
            hasWebCtx: !!webCtx,
            webCtx: webCtx ? String(webCtx).slice(0, 500) : "",
            intent: intentObj,
            systemSettings: reqBody.systemSettings,
          });
        })
        .then(function (planPack) {
          var pj = (planPack && planPack.j) || {};
          allNotes = mergeNotes(allNotes, pj.notes);
          allNotes.push(
            t(
              "⟳ 失败恢复编排（最多自动一次）",
              "⟳ Recovery orchestration (once per turn)"
            )
          );
          if (wantPipelineTrace()) {
            messages[thinkingIdx].modelNote = formatPipelineNote({
              notes: allNotes,
            });
          }
          var steps = Array.isArray(pj.steps) ? pj.steps : [];
          if (!planPack || !planPack.ok || pj.success === false || !steps.length) {
            applyAssistantPack(
              {
                ok: false,
                j: {
                  success: false,
                  wallClockFail: true,
                  error:
                    (pj && pj.error) ||
                    failReason ||
                    t("恢复规划失败", "Recovery plan failed"),
                  notes: allNotes,
                },
              },
              ""
            );
            return null;
          }

          var i = 0;
          function nextStep() {
            if (i >= steps.length) {
              applyAssistantPack(
                {
                  ok: false,
                  j: {
                    success: false,
                    wallClockFail: true,
                    error: t(
                      "恢复分步已执行完毕但仍无有效回答",
                      "Recovery steps finished without a usable answer"
                    ),
                    notes: allNotes,
                  },
                },
                ""
              );
              return null;
            }
            var step = steps[i] || {};
            var op = String(step.op || "").toLowerCase();
            var stepNo = i + 1;
            i += 1;

            if (op === "websearch") {
              if (webCtx) {
                allNotes.push(
                  t(
                    "恢复取舍：已有联网材料，跳过本步 websearch",
                    "Recovery prune: skip websearch (material already present)"
                  )
                );
                if (wantPipelineTrace()) {
                  messages[thinkingIdx].modelNote = formatPipelineNote({
                    notes: allNotes,
                  });
                  renderThread();
                }
                return nextStep();
              }
              setThinkingBusy(4, {
                minor: stepNo,
                verbose: t(
                  "恢复 " + stepNo + "/" + steps.length + "：联网检索…",
                  "Recovery " + stepNo + "/" + steps.length + ": web search…"
                ),
                badge: "Auto · 恢复搜网",
              });
              return postJson("/api/llm-websearch", {
                phone: reqBody.phone,
                message: step.query || reqBody.message,
                lang: reqBody.lang,
                intent: intentObj || { tier: 2, web: true },
                forceWeb: true,
                systemSettings: reqBody.systemSettings,
              }).then(function (webPack) {
                var wj = (webPack && webPack.j) || {};
                allNotes = mergeNotes(allNotes, wj.notes);
                if (wj.webCtx) webCtx = wj.webCtx;
                if (wantPipelineTrace()) {
                  messages[thinkingIdx].modelNote = formatPipelineNote({
                    notes: allNotes,
                  });
                  renderThread();
                }
                return nextStep();
              });
            }

            if (op === "generate") {
              setThinkingBusy(4, {
                minor: stepNo,
                verbose: t(
                  "恢复 " + stepNo + "/" + steps.length + "：生成…",
                  "Recovery " + stepNo + "/" + steps.length + ": generate…"
                ),
                badge: "Auto · 恢复生成",
              });
              if (wantPipelineTrace()) {
                messages[thinkingIdx].modelNote = formatPipelineNote({
                  notes: allNotes,
                });
                renderThread();
              }
              var chatMsg = reqBody.message;
              if (step.focus) {
                chatMsg =
                  String(reqBody.message || "") +
                  "\n\n" +
                  t("【本步焦点】", "[Step focus] ") +
                  step.focus;
              }
              return postJson("/api/llm-chat", {
                phone: reqBody.phone,
                message: chatMsg,
                modelId: "auto",
                lang: reqBody.lang,
                ocr: reqBody.ocr,
                systemSettings: reqBody.systemSettings,
                intent: intentObj || { tier: 1, web: !!webCtx },
                webProvided: true,
                webCtx: webCtx || "",
                catalogItems: ctx.catalogItems || [],
              }).then(function (chatPack) {
                var cj = (chatPack && chatPack.j) || {};
                cj.notes = mergeNotes(allNotes, cj.notes);
                chatPack.j = cj;
                if (cj.success && cj.reply) {
                  applyAssistantPack(chatPack, "");
                  return null;
                }
                // 本步生成仍失败：若还是墙钟且还有后续步骤则继续；否则结束
                allNotes.push(
                  t(
                    "恢复生成失败：" + (cj.error || "error"),
                    "Recovery generate failed: " + (cj.error || "error")
                  )
                );
                if (i < steps.length) return nextStep();
                if (!cj.wallClockFail && isWallClockFail(chatPack)) {
                  cj.wallClockFail = true;
                }
                if (!cj.wallClockFail) {
                  cj.wallClockFail = true;
                  cj.error =
                    (cj.error || "") +
                    (cj.error ? " · " : "") +
                    t(
                      "恢复后仍超时/失败",
                      "Still timed out/failed after recovery"
                    );
                }
                chatPack.j = cj;
                applyAssistantPack(chatPack, "");
                return null;
              });
            }

            allNotes.push(
              t("跳过未知步骤 op=" + op, "Skip unknown step op=" + op)
            );
            return nextStep();
          }

          return nextStep();
        });
    }

    var chain =
      want === "auto"
        ? postJson("/api/llm-intent", {
            phone: reqBody.phone,
            message: reqBody.message,
            lang: reqBody.lang,
            ocr: reqBody.ocr,
            systemSettings: reqBody.systemSettings,
          }).then(function (intentPack) {
            var ij = intentPack.j || {};
            var allNotes = mergeNotes(ij.notes);
            if (allNotes.length && wantPipelineTrace()) {
              messages[thinkingIdx].modelNote = formatPipelineNote({
                notes: allNotes,
              });
            }
            if (!intentPack.ok || ij.success === false) {
              applyAssistantPack(intentPack, "");
              return null;
            }

            var intentObj = ij.intent || null;
            var intentCatalog = !!(intentObj && intentObj.catalog);
            var companyCatalog =
              intentCatalog || isCompanyCatalogQuery(reqBody.message || "");
            var needWeb =
              !companyCatalog &&
              (!!(intentObj && intentObj.web) ||
                /最新|今天|新闻|实时|股价|天气|latest|today|news/i.test(
                  reqBody.message || ""
                ));
            if (companyCatalog && intentObj) {
              intentObj = Object.assign({}, intentObj, {
                catalog: true,
                web: false,
              });
              allNotes.push(
                t(
                  "① 通道 catalog → 跳过联网，改用产品目录",
                  "① Channel catalog → skip web, use site catalog"
                )
              );
            }

            setThinkingBusy(needWeb ? 2 : 3, {
              verbose: needWeb
                ? t("② 正在联网检索…", "② Searching the web…")
                : companyCatalog
                  ? t("③ 正在查询产品目录…", "③ Querying site catalog…")
                  : t("③ 正在生成回答…", "③ Generating answer…"),
              badge: needWeb
                ? "Auto · ②搜网"
                : companyCatalog
                  ? "Auto · 目录"
                  : "Auto · ③生成",
            });

            var afterWeb = Promise.resolve({
              webCtx: "",
              webNote: null,
              webSkipped: "not_needed",
              notes: [],
            });

            if (needWeb) {
              afterWeb = postJson("/api/llm-websearch", {
                phone: reqBody.phone,
                message: reqBody.message,
                lang: reqBody.lang,
                intent: intentObj,
                systemSettings: reqBody.systemSettings,
              }).then(function (webPack) {
                var wj = webPack.j || {};
                allNotes = mergeNotes(allNotes, wj.notes);
                if (wantPipelineTrace()) {
                  messages[thinkingIdx].modelNote = formatPipelineNote({
                    notes: allNotes,
                  });
                  renderThread();
                }
                if (!webPack.ok || wj.success === false) {
                  allNotes.push(
                    t(
                      "② 搜网请求失败，将无联网材料继续③生成",
                      "② Websearch failed; continue to ③ generate without web"
                    )
                  );
                  return {
                    webCtx: "",
                    webSkipped: "request_failed",
                    notes: wj.notes || [],
                  };
                }
                return {
                  webCtx: typeof wj.webCtx === "string" ? wj.webCtx : "",
                  webSkipped: wj.skipped || null,
                  notes: wj.notes || [],
                  webSearch: wj.webSearch || null,
                  webPack: wj.webPack || null,
                };
              });
            }

            return afterWeb.then(function (webInfo) {
              var catalogWait = Promise.resolve(catalogPromise || []);
              if (companyCatalog) {
                catalogWait = catalogWait.then(function (items) {
                  if (items && items.length) return items;
                  return searchCatalogForShowcase(reqBody.message || "", {
                    forceBrowse: true,
                  });
                });
              }
              return catalogWait.then(function (catalogItems) {
                if (catalogItems && catalogItems.length) {
                  allNotes.push(
                    t(
                      "③ 目录命中 → 主展区展示，对话仅短提示",
                      "③ Catalog hits → showcase; short chat tip only"
                    )
                  );
                  if (wantPipelineTrace()) {
                    messages[thinkingIdx].modelNote = formatPipelineNote({
                      notes: allNotes,
                    });
                  }
                  clearThinkPulse();
                  messages[thinkingIdx] = {
                    role: "assistant",
                    text: t(
                      "相关产品/方案已在左侧展示区列出，点击缩略图可查看详情。",
                      "Matching products/solutions are in the showcase — tap a thumbnail for details."
                    ),
                    model: "auto",
                    modelBadge: "Auto · 目录",
                    modelNote: wantPipelineTrace()
                      ? formatPipelineNote({ notes: allNotes })
                      : "",
                  };
                  renderThread();
                  return null;
                }
                if (companyCatalog) {
                  allNotes.push(
                    t(
                      "③ 目录无命中 → 短提示（不联网）",
                      "③ No catalog hits → short tip (no web)"
                    )
                  );
                  if (wantPipelineTrace()) {
                    messages[thinkingIdx].modelNote = formatPipelineNote({
                      notes: allNotes,
                    });
                  }
                  clearThinkPulse();
                  messages[thinkingIdx] = {
                    role: "assistant",
                    text: t(
                      "目录里暂未匹配到相关产品/方案。请确认产品目录有已启用条目；若刚录入，可在运维里点「重建向量索引」后再试。",
                      "No matching catalog items. Ensure active catalog entries exist; after edits, rebuild the vector index."
                    ),
                    model: "auto",
                    modelBadge: "Auto · 目录",
                    modelNote: wantPipelineTrace()
                      ? formatPipelineNote({ notes: allNotes })
                      : "",
                  };
                  renderThread();
                  return null;
                }

                setThinkingBusy(3, {
                  verbose: t("③ 正在生成回答…", "③ Generating answer…"),
                  badge: "Auto · ③生成",
                });
                if (wantPipelineTrace()) {
                  messages[thinkingIdx].modelNote = formatPipelineNote({
                    notes: allNotes,
                  });
                  renderThread();
                }

                var chatBody = Object.assign({}, reqBody, {
                  intent: intentObj,
                  webProvided: true,
                  webCtx: webInfo.webCtx || "",
                  webSkipped: webInfo.webSkipped || null,
                  webSearch: webInfo.webSearch || null,
                  webPack: webInfo.webPack || null,
                  catalogItems: [],
                });

                var afterChat;
                if (wantForceFailGenerate()) {
                  allNotes.push(
                    t(
                      "③ 调试：强制模拟生成墙钟失败（llmForceFailGenerate=1）",
                      "③ Debug: force-simulate generate wall-clock fail (llmForceFailGenerate=1)"
                    )
                  );
                  afterChat = Promise.resolve({
                    ok: false,
                    status: 502,
                    j: {
                      success: false,
                      wallClockFail: true,
                      error: t(
                        "（调试）强制模拟 Cloudflare HTML 502，用于测试失败恢复编排",
                        "(debug) Forced Cloudflare HTML 502 to test recovery orchestration"
                      ),
                      notes: allNotes.slice(),
                    },
                  });
                } else {
                  afterChat = postJson("/api/llm-chat", chatBody);
                }

                return afterChat.then(function (chatPack) {
                  var cj = chatPack.j || {};
                  cj.notes = mergeNotes(allNotes, cj.notes);
                  chatPack.j = cj;
                  if (cj.success && cj.reply) {
                    applyAssistantPack(chatPack, "");
                    return null;
                  }
                  if (isWallClockFail(chatPack)) {
                    return runRecoverPlan({
                      intentObj: intentObj,
                      webCtx: chatBody.webCtx || "",
                      allNotes: cj.notes || allNotes,
                      failReason: cj.error || "",
                      failStatus: chatPack.status || 0,
                      catalogItems: catalogItems || [],
                    });
                  }
                  applyAssistantPack(chatPack, "");
                  return null;
                });
              });
            });
          })
        : Promise.resolve(catalogPromise || []).then(function (catalogItems) {
            return postJson(
              "/api/llm-chat",
              Object.assign({}, reqBody, {
                catalogItems: catalogItems || [],
              })
            ).then(function (pack) {
              applyAssistantPack(pack, "");
            });
          });

    chain.catch(function (err) {
      clearThinkPulse();
      messages[thinkingIdx] = {
        role: "assistant",
        text:
          t("网络错误：", "Network error: ") +
          String((err && err.message) || err),
        model: want,
        modelBadge: formatModelBadge(null, want),
        modelNote: messages[thinkingIdx] && messages[thinkingIdx].modelNote,
      };
      renderThread();
    });
  }

  function closePlusMenuSafe() {
    if (root && typeof root._aiClosePlusMenu === "function") root._aiClosePlusMenu();
  }

  function dispatchAgentVisible() {
    try {
      document.dispatchEvent(
        new CustomEvent("hzdv:agent-visible", {
          detail: { visible: !!visible, opened: !!opened },
        })
      );
    } catch (e) {}
  }

  // 前端先用内置同义词；启动后拉 D1 表覆盖（/api/catalog-public?synonyms=1）
  var synonymMapCache = null;
  var OUR_SITE =
    /你们|咱们|咱家|贵司|本公司|本站|迪微|HZDV|hzdv|贵公司|你们公司/i;
  var BROWSE_ASK =
    /有什么|有哪些|都有什么|介绍一下|看看|列一下|展示一下|有没有|能否介绍|想了解/;
  var SHOWCASE_NAV =
    /回到|返回|再看|再来|换回|换成|换到|换个|切换|切到|打开|展示|列表|缩略图|主展区|目录页|看下|看一下|换/;
  var DEFAULT_CATALOG_MAP = {
    product: ["产品", "单品", "设备", "阀门", "仪表", "模块", "配件", "货品", "商品"],
    solution: [
      "方案",
      "系统集成",
      "成套",
      "产线",
      "装配线",
      "集成系统",
      "交钥匙",
    ],
    case: ["案例", "例子", "实例", "应用案例", "成功案例", "项目案例", "样板"],
  };
  var DEFAULT_CATALOG_NOUN =
    /产品|单品|设备|阀门|仪表|模块|配件|型号|货品|商品|方案|系统集成|成套|产线|装配线|集成系统|交钥匙|案例|例子|实例|应用案例|成功案例|项目案例|目录|型号库/;

  function escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function activeSynonymMap() {
    return synonymMapCache || DEFAULT_CATALOG_MAP;
  }

  function catalogNounRegex() {
    var map = activeSynonymMap();
    var terms = [];
    ["product", "solution", "case"].forEach(function (k) {
      (map[k] || []).forEach(function (a) {
        var t = String(a || "").trim();
        if (t && terms.indexOf(t) < 0) terms.push(t);
      });
    });
    terms.push("目录", "型号库", "型号");
    terms.sort(function (a, b) {
      return b.length - a.length;
    });
    if (!terms.length) return DEFAULT_CATALOG_NOUN;
    try {
      return new RegExp(terms.map(escapeRegExp).join("|"));
    } catch (e) {
      return DEFAULT_CATALOG_NOUN;
    }
  }

  /** @returns {"product"|"solution"|"case"|null} */
  function detectCatalogKind(message) {
    var s = String(message || "").trim();
    if (!s) return null;
    var map = activeSynonymMap();
    var best = null;
    var bestIdx = Infinity;
    ["product", "solution", "case"].forEach(function (kind) {
      (map[kind] || []).forEach(function (a) {
        var t = String(a || "").trim();
        if (!t) return;
        var idx = s.toLowerCase().indexOf(t.toLowerCase());
        if (idx >= 0 && idx < bestIdx) {
          bestIdx = idx;
          best = kind;
        }
      });
    });
    return best;
  }

  function ensureSynonymMap() {
    if (synonymMapCache) return Promise.resolve(synonymMapCache);
    return fetch("/api/catalog-public?synonyms=1", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.success && j.synonyms) synonymMapCache = j.synonyms;
        return synonymMapCache;
      })
      .catch(function () {
        return null;
      });
  }

  function isShortCatalogNav(s) {
    return /^(请|帮我|给我)?(再)?(看|换|切|回|返|打开|展示)?(到|回|成|个)?(本站|你们|咱们|公司)?(的)?(产品|方案|案例|系统集成)(展示页面|展示页|展示区|展示|列表|页面|页|目录|缩略图)?(吧|啊|呀|呢|吗)?[？?！!\.。]*$/i.test(
      String(s || "").trim()
    );
  }

  function isBrowseCatalogQuery(message) {
    var s = String(message || "").trim();
    if (!s) return false;
    var noun = catalogNounRegex();
    var kind = detectCatalogKind(s);
    if (BROWSE_ASK.test(s) && noun.test(s)) return true;
    if (noun.test(s) && /(列表|一览|目录|清单)/.test(s)) return true;
    if (OUR_SITE.test(s) && BROWSE_ASK.test(s)) return true;
    if (kind && SHOWCASE_NAV.test(s)) return true;
    if (isShortCatalogNav(s)) return true;
    return false;
  }

  function isCompanyCatalogQuery(message) {
    var s = String(message || "").trim();
    if (!s) return false;
    if (isBrowseCatalogQuery(s)) return true;
    var noun = catalogNounRegex();
    var kind = detectCatalogKind(s);
    if (OUR_SITE.test(s) && noun.test(s)) return true;
    if (BROWSE_ASK.test(s) && noun.test(s)) return true;
    if (kind && SHOWCASE_NAV.test(s)) return true;
    if (isShortCatalogNav(s)) return true;
    if (
      /(有没有|有吗|推荐|适合|用于).{0,20}(装配|产线|阀门|仪表|洁净|模块|工位)/.test(
        s
      )
    ) {
      return true;
    }
    return false;
  }

  function filterItemsByKind(items, kind) {
    if (!kind || !items || !items.length) return items || [];
    return items.filter(function (it) {
      return String((it && it.kind) || "product") === kind;
    });
  }

  /** @returns {Promise<object[]>} */
  function searchCatalogForShowcase(query, opts) {
    var q = String(query || "").trim();
    if (!q) return Promise.resolve([]);
    var forceBrowse = !!(opts && opts.forceBrowse);
    return ensureSynonymMap().then(function () {
      var browse = forceBrowse || isBrowseCatalogQuery(q);
      var kind = detectCatalogKind(q);
      var kindQs = kind ? "&kind=" + encodeURIComponent(kind) : "";
      var url = browse
        ? "/api/catalog-public?browse=1&topK=20" + kindQs
        : "/api/catalog-public?q=" +
          encodeURIComponent(q) +
          "&topK=8" +
          kindQs;
      return fetch(url, { cache: "no-store" })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          var items = j && Array.isArray(j.items) ? j.items : [];
          items = filterItemsByKind(items, kind);
          if (
            (!j || j.success === false || !items.length) &&
            !browse &&
            isCompanyCatalogQuery(q)
          ) {
            return fetch(
              "/api/catalog-public?browse=1&topK=20" + kindQs,
              { cache: "no-store" }
            )
              .then(function (r2) {
                return r2.json();
              })
              .then(function (j2) {
                var list = j2 && Array.isArray(j2.items) ? j2.items : [];
                return filterItemsByKind(list, kind);
              })
              .catch(function () {
                return [];
              });
          }
          return items;
        })
        .then(function (items) {
          if (items && items.length) {
            try {
              if (
                global.SolutionShowcase &&
                typeof global.SolutionShowcase.showHits === "function"
              ) {
                global.SolutionShowcase.showHits(items, q);
              }
            } catch (eShow) {
              try {
                console.warn("[catalog] showcase render failed", eShow);
              } catch (eLog) {}
            }
            try {
              document.dispatchEvent(
                new CustomEvent("hzdv:catalog-hits", {
                  detail: { query: q, items: items, kind: kind },
                })
              );
            } catch (e2) {}
          }
          return items || [];
        })
        .catch(function () {
          return [];
        });
    });
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
    dispatchAgentVisible();
  }

  function hideAll() {
    if (!root) return;
    if (asrMic.recording) stopMicCapture();
    visible = false;
    opened = false;
    closeModelMenu();
    closePlusMenuSafe();
    closeLightbox();
    clearAttachment();
    root.classList.remove("is-visible", "is-open");
    root.setAttribute("aria-hidden", "true");
    syncNavActive();
    dispatchAgentVisible();
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
    dispatchAgentVisible();
  }

  function closeChat() {
    // 不再收成底部/侧栏卷帘条，关闭即整组消失
    hideAll();
  }

  function syncNavActive() {
    var link = document.getElementById("topNavAiAssist");
    if (!link) return;
    link.classList.toggle("is-active", !!visible);
    link.setAttribute("aria-expanded", visible ? "true" : "false");
  }

  function toggleFromNav() {
    ensureDom();
    // 顶栏「AI助手」：直接展开对话，不再先出卷帘条再点一次
    if (visible) hideAll();
    else openChat();
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
    if (opened || visible) hideAll();
  });

  document.addEventListener("hzdv:catalog-item-open", function (e) {
    var d = (e && e.detail) || {};
    if (!d.name || !opened) return;
    var kindZh =
      d.kind === "solution"
        ? t("方案", "solution")
        : d.kind === "case"
          ? t("案例", "case")
          : t("产品", "product");
    var tip =
      t("已在左侧打开", "Opened on the left: ") +
      kindZh +
      "「" +
      d.name +
      "」" +
      (d.model ? "（" + d.model + "）" : "") +
      t("。", ".");
    appendAssistant(tip, { modelBadge: t("目录", "Catalog") });
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
