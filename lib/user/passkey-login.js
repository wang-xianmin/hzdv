/**
 * Passkey 前端 T3：完整登录 ceremony（依赖 window.HZDVPasskeyAuth）。
 * POST /api/passkey/authenticate/options → navigator.credentials.get → verify；失败不自动降级。
 */
(function (global) {
  "use strict";

  var auth = global.HZDVPasskeyAuth;
  if (!auth) {
    throw new Error("HZDVPasskeyAuth 尚未加载，请先加载 passkey-auth.js");
  }

  var VAGUE_FAIL = auth.VAGUE_FAIL || "Passkey operation could not be completed";

  function vagueError() {
    return new Error(VAGUE_FAIL);
  }

  /**
   * @param {Object=} body 传给 POST /api/passkey/authenticate/options
   * @returns {Promise<{ceremonyId: string, credential: PublicKeyCredential, result: Object}>}
   */
  async function loginWithPasskey(body) {
    try {
      var optionsResp = await auth.getAuthenticateOptions(body || {});
      var ceremonyId = optionsResp && optionsResp.ceremonyId;
      var publicKey = optionsResp && optionsResp.publicKey;
      if (!ceremonyId || !publicKey) throw vagueError();

      var credential;
      try {
        credential = await navigator.credentials.get({ publicKey: publicKey });
      } catch (webErr) {
        // 浏览器原生错误：NotAllowedError = 没有可用的通行密钥，或用户取消了选择
        var e = vagueError();
        if (webErr && webErr.name === "NotAllowedError") e.kind = "notallowed";
        throw e;
      }
      if (!credential) throw vagueError();

      var result = await auth.verifyAuthenticate(ceremonyId, credential);
      if (result && result.sessionToken) {
        auth.setSessionCookie(result.sessionToken);
      }
      return { ceremonyId: ceremonyId, credential: credential, result: result || {} };
    } catch (err) {
      // 只透出可安全使用的信号：kind（仅浏览器原生 NotAllowedError）、needReauth（后端统一布尔）、
      // HTTP 状态码（仅用于 404/429/5xx 这类全局态判断，不用于判断账号是否存在）。
      var out = vagueError();
      if (err && err.status != null) out.status = err.status;
      if (err && err.needReauth === true) out.needReauth = true;
      if (err && err.kind) out.kind = err.kind;
      throw out;
    }
  }

  global.HZDVPasskeyLogin = {
    loginWithPasskey: loginWithPasskey,
  };
})(typeof window !== "undefined" ? window : globalThis);
