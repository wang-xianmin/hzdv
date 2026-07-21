window.APP_CONFIG = {
  IS_LOCAL_DEV: false,
  API_CONFIG: {
    baseUrl: "",
  },
  DEV_CONFIG: {
    debug: false,
    /** 发信成功后把 6 位验证码打到浏览器 Console（无自有域名、收不到邮件时自测用） */
    logVerificationCodeToConsole: true,
  },
  TURNSTILE: {
    enabled: false,
    siteKey: "",
    verifyEndpoint: "/api/verify-turnstile",
    requireForNewUserKv: false,
  },
  QR_CONFIG: {
    generator: "qrserver",
    size: 140,
  },
};
