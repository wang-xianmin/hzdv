/**
 * Passkey 前端 T1：WebAuthn API 薄封装（仅对接既有后端端点）。
 * - 不自动降级到邮箱/扫码
 * - 不以 localStorage phone/uuid 作为身份
 * - 对调用方返回模糊错误文案
 */
(function (global) {
  "use strict";

  var VAGUE_FAIL = "Passkey operation could not be completed";
  var SESSION_COOKIE = "hzdv_session";

  function bufferToBase64url(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64urlToBuffer(s) {
    var str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function vagueError(err) {
    var e = new Error(VAGUE_FAIL);
    if (err && err.status != null) e.status = err.status;
    // 后端统一失败体里的 needReauth 布尔（对所有『身份无效』原因取值一致，不含账号信息）
    if (err && err.needReauth === true) e.needReauth = true;
    if (err && err.data && err.data.needReauth === true) e.needReauth = true;
    return e;
  }

  async function fetchJSON(url, options) {
    var opts = options || {};
    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (opts.body != null && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    var res;
    try {
      res = await fetch(url, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body != null ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
        credentials: "include",
      });
    } catch (networkErr) {
      throw vagueError(networkErr);
    }
    var data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      throw vagueError({ status: res.status, data: data });
    }
    return data;
  }

  function publicKeyOptionsFromServer(publicKey) {
    if (!publicKey || typeof publicKey !== "object") return publicKey;
    var pk = Object.assign({}, publicKey);
    if (typeof pk.challenge === "string") pk.challenge = base64urlToBuffer(pk.challenge);
    if (pk.user && typeof pk.user.id === "string") {
      pk.user = Object.assign({}, pk.user, { id: base64urlToBuffer(pk.user.id) });
    }
    if (Array.isArray(pk.excludeCredentials)) {
      pk.excludeCredentials = pk.excludeCredentials.map(function (c) {
        var x = Object.assign({}, c);
        if (typeof x.id === "string") x.id = base64urlToBuffer(x.id);
        return x;
      });
    }
    if (Array.isArray(pk.allowCredentials)) {
      pk.allowCredentials = pk.allowCredentials.map(function (c) {
        var x = Object.assign({}, c);
        if (typeof x.id === "string") x.id = base64urlToBuffer(x.id);
        return x;
      });
    }
    return pk;
  }

  function credentialToJSON(cred) {
    if (!cred) return null;
    var resp = cred.response || {};
    var out = {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type || "public-key",
      response: {},
    };
    if (resp.clientDataJSON) out.response.clientDataJSON = bufferToBase64url(resp.clientDataJSON);
    if (resp.attestationObject) out.response.attestationObject = bufferToBase64url(resp.attestationObject);
    if (resp.authenticatorData) out.response.authenticatorData = bufferToBase64url(resp.authenticatorData);
    if (resp.signature) out.response.signature = bufferToBase64url(resp.signature);
    if (resp.userHandle) out.response.userHandle = bufferToBase64url(resp.userHandle);
    return out;
  }

  async function getRegisterOptions(body) {
    var data = await fetchJSON("/api/passkey/register/options", {
      method: "POST",
      body: body || {},
    });
    if (data && data.publicKey) data.publicKey = publicKeyOptionsFromServer(data.publicKey);
    return data;
  }

  async function verifyRegister(ceremonyId, credential) {
    return fetchJSON("/api/passkey/register/verify", {
      method: "POST",
      body: {
        ceremonyId: ceremonyId,
        credential: credential && credential.rawId ? credentialToJSON(credential) : credential,
      },
    });
  }

  async function getAuthenticateOptions(body) {
    var data = await fetchJSON("/api/passkey/authenticate/options", {
      method: "POST",
      body: body || {},
    });
    if (data && data.publicKey) data.publicKey = publicKeyOptionsFromServer(data.publicKey);
    return data;
  }

  async function verifyAuthenticate(ceremonyId, credential) {
    return fetchJSON("/api/passkey/authenticate/verify", {
      method: "POST",
      body: {
        ceremonyId: ceremonyId,
        credential: credential && credential.rawId ? credentialToJSON(credential) : credential,
      },
    });
  }

  function setSessionCookie(sessionToken, maxAgeSec) {
    var token = String(sessionToken || "").trim();
    if (!token) throw vagueError();
    var maxAge = maxAgeSec == null ? 7 * 24 * 60 * 60 : Number(maxAgeSec) || 0;
    var parts = [
      SESSION_COOKIE + "=" + encodeURIComponent(token),
      "Path=/",
      "SameSite=Lax",
      "Max-Age=" + String(maxAge),
    ];
    if (typeof location !== "undefined" && location.protocol === "https:") parts.push("Secure");
    document.cookie = parts.join("; ");
  }

  async function listPasskeys() {
    return fetchJSON("/api/passkeys", { method: "GET" });
  }

  async function revokePasskey(credentialId, reauthToken) {
    var id = encodeURIComponent(String(credentialId || ""));
    // 撤销票据走请求头：DELETE 带 body 会被部分 CDN/WAF 丢弃，导致撤销永远 401。
    // 严禁改成 body 传票（后端仍保留 body.reauthToken 作为兼容回退）。
    var headers = {};
    var token = String(reauthToken || "").trim();
    if (token) headers["X-Reauth-Token"] = token;
    return fetchJSON("/api/passkeys/" + id, { method: "DELETE", headers: headers });
  }

  var api = {
    VAGUE_FAIL: VAGUE_FAIL,
    bufferToBase64url: bufferToBase64url,
    base64urlToBuffer: base64urlToBuffer,
    fetchJSON: fetchJSON,
    credentialToJSON: credentialToJSON,
    getRegisterOptions: getRegisterOptions,
    verifyRegister: verifyRegister,
    getAuthenticateOptions: getAuthenticateOptions,
    verifyAuthenticate: verifyAuthenticate,
    setSessionCookie: setSessionCookie,
    listPasskeys: listPasskeys,
    revokePasskey: revokePasskey,
  };

  global.HZDVPasskeyAuth = api;
})(typeof window !== "undefined" ? window : globalThis);
