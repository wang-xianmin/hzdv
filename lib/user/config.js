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
    enabled: true,
    siteKey: "",
    verifyEndpoint: "/api/verify-turnstile",
    /** 新人注册写 KV 前必须过人机验证（服务端默认也校验；仅本地且 REGISTER_KV_SKIP_TURNSTILE 时可改 false） */
    requireForNewUserKv: true,
  },
  QR_CONFIG: {
    /** 二维码生成器：qrcodejs = 自托管 node-qrcode（同源静态文件，无第三方域名） */
    generator: "qrcodejs",
    /** 二维码图片边长（px，含静区） */
    size: 140,
    /** 静区宽度（模块数） */
    margin: 2,
    color: {
      dark: "#003366",
      light: "#ffffff",
    },
  },
};
