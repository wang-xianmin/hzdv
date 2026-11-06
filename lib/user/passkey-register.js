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
   * 完整注册 ceremony：options → navigator.credentials.create → verify。
   *
   * 契约（供个人资料面板等调用方复用，本文件是唯一的注册实现）：
   *   - body 可含 {reauthToken}：仅存在于内存的一次性 reauth 票据，
   *     直接透传给 POST /api/passkey/register/options；不得写入 localStorage / DOM / 日志。
   *   - 未带 reauthToken 时依赖既有会话 Cookie；后端要求重新验证时抛 needReauth/401，
   *     由调用方（HZDVPasskeyManager）弹 reauth 浮层并带票据重试。
   *   - 返回值不含任何票据/密码；调用方只消费 credential 与 result。
   *
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
      // 只透出可安全使用的信号：needReauth（后端统一布尔）与 HTTP 状态码（仅用于全局态判断）。
      // 不在此处生成任何与『账号是否存在 / 是否已有 passkey』相关的文案。
      var out = vagueError();
      if (err && err.status != null) out.status = err.status;
      if (err && err.needReauth === true) out.needReauth = true;
      if (err && err.kind) out.kind = err.kind;
      throw out;
    }
  }

  global.HZDVPasskeyRegister = {
    registerPasskey: registerPasskey,
    isSupported: !!global.PublicKeyCredential,
  };
})(typeof window !== "undefined" ? window : globalThis);
