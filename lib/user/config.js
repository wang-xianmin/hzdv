window.APP_CONFIG = {
  IS_LOCAL_DEV: false,
  API_CONFIG: {
    baseUrl: "",
  },
  DEV_CONFIG: {
    debug: false,
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
