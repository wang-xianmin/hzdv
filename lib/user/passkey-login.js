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

      var credential = await navigator.credentials.get({ publicKey: publicKey });
      if (!credential) throw vagueError();

      var result = await auth.verifyAuthenticate(ceremonyId, credential);
      if (result && result.sessionToken) {
        auth.setSessionCookie(result.sessionToken);
      }
      return { ceremonyId: ceremonyId, credential: credential, result: result || {} };
    } catch (err) {
      throw vagueError();
    }
  }

  global.HZDVPasskeyLogin = {
    loginWithPasskey: loginWithPasskey,
  };
})(typeof window !== "undefined" ? window : globalThis);
