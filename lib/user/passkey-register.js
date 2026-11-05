/**
 * Passkey 前端 T2：完整注册 ceremony（依赖 window.HZDVPasskeyAuth）。
 * options → navigator.credentials.create → verify；失败不自动降级。
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
   * @param {Object=} body 传给 POST /api/passkey/register/options（靠已有会话 Cookie）
   * @returns {Promise<{ceremonyId: string, credential: PublicKeyCredential, result: Object}>}
   */
  async function registerPasskey(body) {
    try {
      var optionsResp = await auth.getRegisterOptions(body || {});
      var ceremonyId = optionsResp && optionsResp.ceremonyId;
      var publicKey = optionsResp && optionsResp.publicKey;
      if (!ceremonyId || !publicKey) throw vagueError();

      var credential = await navigator.credentials.create({ publicKey: publicKey });
      if (!credential) throw vagueError();

      var result = await auth.verifyRegister(ceremonyId, credential);
      if (result && result.sessionToken) {
        auth.setSessionCookie(result.sessionToken);
      }
      return { ceremonyId: ceremonyId, credential: credential, result: result || {} };
    } catch (err) {
      throw vagueError();
    }
  }

  global.HZDVPasskeyRegister = {
    registerPasskey: registerPasskey,
  };
})(typeof window !== "undefined" ? window : globalThis);
