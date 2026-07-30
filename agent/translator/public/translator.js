/**
 * 面对面口译 · 按住说话（Mac / 手机浏览器可测）
 * 依赖同源 /api/translate-turn、登录 phone（leng_phone / getCurrentUserPhone）
 */
(function () {
  "use strict";

  var displayMode = "both"; // both | zh | en
  var busy = false;
  var session = null; // { direction, chunks, ctx, stream, ... }

  var el = {
    gate: document.getElementById("trGate"),
    gateMsg: document.getElementById("trGateMsg"),
    main: document.getElementById("trMain"),
    status: document.getElementById("trStatus"),
    src: document.getElementById("trSrc"),
    srcLabel: document.getElementById("trSrcLabel"),
    srcText: document.getElementById("trSrcText"),
    dst: document.getElementById("trDst"),
    dstLabel: document.getElementById("trDstLabel"),
    dstText: document.getElementById("trDstText"),
    speakOn: document.getElementById("trSpeakOn"),
    me: document.getElementById("trPttMe"),
    them: document.getElementById("trPttThem"),
  };

  function getPhone() {
    if (typeof window.getCurrentUserPhone === "function") {
      var p = window.getCurrentUserPhone();
      if (p) return p;
    }
    try {
      return String(localStorage.getItem("leng_phone") || "").replace(/\D/g, "");
    } catch (e) {
      return "";
    }
  }

  function isLoggedIn() {
    try {
      if (localStorage.getItem("leng_logged_in") === "1" && getPhone()) return true;
    } catch (e) {}
    return !!getPhone();
  }

  function canUseTranslator() {
    if (typeof window.userCanUseTranslator === "function") {
      return window.userCanUseTranslator();
    }
    return isLoggedIn();
  }

  function setStatus(text, kind) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("is-busy", kind === "busy");
    el.status.classList.toggle("is-err", kind === "err");
  }

  function applyDisplay() {
    var hasSrc = !!(el.srcText && el.srcText.textContent);
    var hasDst = !!(el.dstText && el.dstText.textContent);
    var srcLang = (el.src && el.src.dataset.lang) || "zh";
    var dstLang = (el.dst && el.dst.dataset.lang) || "en";
    function want(lang) {
      return displayMode === "both" || displayMode === lang;
    }
    if (el.src) el.src.hidden = !(hasSrc && want(srcLang));
    if (el.dst) el.dst.hidden = !(hasDst && want(dstLang));
  }

  function showResult(pack) {
    var srcLang = pack.sourceLang || "zh";
    var dstLang = pack.targetLang || "en";
    if (el.srcLabel) {
      el.srcLabel.textContent = srcLang === "zh" ? "原文 · 中文" : "原文 · English";
    }
    if (el.dstLabel) {
      el.dstLabel.textContent = dstLang === "zh" ? "译文 · 中文" : "译文 · English";
    }
    if (el.src) el.src.dataset.lang = srcLang;
    if (el.dst) el.dst.dataset.lang = dstLang;
    if (el.srcText) el.srcText.textContent = pack.sourceText || "";
    if (el.dstText) el.dstText.textContent = pack.translatedText || "";
    applyDisplay();
  }

  function speakText(text, lang) {
    if (!el.speakOn || !el.speakOn.checked) return;
    if (!window.speechSynthesis || !text) return;
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
    var u = new SpeechSynthesisUtterance(String(text));
    u.lang = lang === "zh" ? "zh-CN" : "en-US";
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
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

  function resampleLinear(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var outLen = Math.max(1, Math.round(input.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var x = i * ratio;
      var i0 = Math.floor(x);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var t = x - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
    return out;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || "");
        var i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function setHoldingUi(btn, on) {
    if (!btn) return;
    btn.classList.toggle("is-holding", !!on);
  }

  function setButtonsDisabled(on) {
    if (el.me) el.me.disabled = !!on;
    if (el.them) el.them.disabled = !!on;
  }

  async function startHold(direction, btn) {
    if (busy || session) return;
    if (!canUseTranslator()) {
      setStatus("无权限或未登录", "err");
      return;
    }
    setStatus(direction === "me" ? "正在听你说…" : "正在听对方说…", "busy");
    setHoldingUi(btn, true);
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var source = ctx.createMediaStreamSource(stream);
      var processor = ctx.createScriptProcessor(4096, 1, 1);
      var chunks = [];
      processor.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
      };
      source.connect(processor);
      var mute = ctx.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(ctx.destination);
      session = {
        direction: direction,
        btn: btn,
        stream: stream,
        ctx: ctx,
        source: source,
        processor: processor,
        mute: mute,
        chunks: chunks,
        sampleRate: ctx.sampleRate || 48000,
      };
    } catch (err) {
      setHoldingUi(btn, false);
      setStatus(
        "无法打开麦克风：" + String((err && err.message) || err),
        "err"
      );
    }
  }

  function stopTracks(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    } catch (e) {}
  }

  async function endHold() {
    if (!session) return;
    var s = session;
    session = null;
    setHoldingUi(s.btn, false);

    try {
      if (s.processor) {
        s.processor.onaudioprocess = null;
        s.processor.disconnect();
      }
      if (s.source) s.source.disconnect();
    } catch (e) {}
    stopTracks(s.stream);
    try {
      if (s.ctx && s.ctx.state !== "closed") await s.ctx.close();
    } catch (e2) {}

    var total = 0;
    for (var i = 0; i < s.chunks.length; i++) total += s.chunks[i].length;
    if (total < 1600) {
      setStatus("说话太短，请按住再说一会儿", "err");
      return;
    }
    var merged = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < s.chunks.length; j++) {
      merged.set(s.chunks[j], off);
      off += s.chunks[j].length;
    }
    var pcm16 = resampleLinear(merged, s.sampleRate, 16000);
    var wav = encodeWavMono(pcm16, 16000);

    busy = true;
    setButtonsDisabled(true);
    setStatus("识别并翻译中…", "busy");
    try {
      var b64 = await blobToBase64(wav);
      var res = await fetch("/api/translate-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: getPhone(),
          direction: s.direction,
          audio: b64,
        }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok || data.success === false) {
        if (data.sourceText) {
          showResult({
            sourceText: data.sourceText,
            translatedText: "",
            sourceLang: data.sourceLang || (s.direction === "them" ? "en" : "zh"),
            targetLang: data.targetLang || (s.direction === "them" ? "zh" : "en"),
          });
        }
        setStatus(String(data.error || "请求失败"), "err");
        return;
      }
      showResult(data);
      var ms = data.latencyMs != null ? " · " + data.latencyMs + "ms" : "";
      setStatus("完成" + ms);
      speakText(data.speakText || data.translatedText, data.targetLang || "en");
    } catch (err) {
      setStatus("网络错误：" + String((err && err.message) || err), "err");
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  function bindPtt(btn, direction) {
    if (!btn) return;
    var active = false;

    function down(ev) {
      if (busy) return;
      if (ev.type === "mousedown" && ev.button !== 0) return;
      ev.preventDefault();
      if (active) return;
      active = true;
      startHold(direction, btn);
    }
    function up(ev) {
      if (!active) return;
      active = false;
      if (ev) ev.preventDefault();
      endHold();
    }

    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", function (ev) {
      if (active && ev.pointerType === "mouse") up(ev);
    });
    // 防止长按弹出系统菜单
    btn.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
    });
  }

  function initDisplayToggles() {
    document.querySelectorAll(".tr-seg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        displayMode = btn.getAttribute("data-display") || "both";
        document.querySelectorAll(".tr-seg-btn").forEach(function (b) {
          b.classList.toggle("is-on", b === btn);
        });
        applyDisplay();
      });
    });
  }

  function boot() {
    initDisplayToggles();
    bindPtt(el.me, "me");
    bindPtt(el.them, "them");

    if (!canUseTranslator()) {
      if (el.gate) el.gate.hidden = false;
      if (el.main) el.main.hidden = true;
      if (el.gateMsg) {
        el.gateMsg.textContent = isLoggedIn()
          ? "当前账号无权使用口译功能，请联系管理员开通。"
          : "请先在首页登录后再使用口译功能。";
      }
      return;
    }
    if (el.gate) el.gate.hidden = true;
    if (el.main) el.main.hidden = false;
    setStatus("按住下方按钮开始");
  }

  boot();
})();
