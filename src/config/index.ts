import { env } from "./env.js";

export { env, type Env } from "./env.js";

export const config = {
  env: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === "development",
  isTest: env.NODE_ENV === "test",
  isProduction: env.NODE_ENV === "production",

  server: {
    host: env.HOST,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY,
  },

  log: {
    level: env.LOG_LEVEL,
  },

  database: {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    testUrl: env.TEST_DATABASE_URL,
  },

  redis: {
    url: env.REDIS_URL,
  },

  auth: {
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,

    otp: {
      codeLength: env.AUTH_OTP_CODE_LENGTH,
      ttlSeconds: env.AUTH_OTP_TTL_SECONDS,
      maxAttempts: env.AUTH_OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: env.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
      maxResends: env.AUTH_OTP_MAX_RESENDS,
    },

    rateLimits: {
      windowSeconds: env.AUTH_OTP_RATE_WINDOW_SECONDS,
      sendPerIp: env.AUTH_OTP_SEND_IP_LIMIT,
      sendPerPhone: env.AUTH_OTP_SEND_PHONE_LIMIT,
      verifyPerIp: env.AUTH_OTP_VERIFY_IP_LIMIT,
      verifyPerPhone: env.AUTH_OTP_VERIFY_PHONE_LIMIT,
    },
  },

  contacts: {
    maxBatch: env.CONTACTS_MATCH_MAX_BATCH,
    windowSeconds: env.CONTACTS_MATCH_WINDOW_SECONDS,
    userRequestLimit: env.CONTACTS_MATCH_USER_REQUEST_LIMIT,
    ipRequestLimit: env.CONTACTS_MATCH_IP_REQUEST_LIMIT,
    userNumberLimit: env.CONTACTS_MATCH_USER_NUMBER_LIMIT,
    queryTimeoutMs: env.CONTACTS_MATCH_QUERY_TIMEOUT_MS,
  },

  groups: {
    maxMembers: env.GROUP_MAX_MEMBERS,
  },

  msg91: {
    apiBaseUrl: env.MSG91_API_BASE_URL,
    authKey: env.MSG91_AUTH_KEY,
    templateId: env.MSG91_OTP_TEMPLATE_ID,
    otpLength: env.AUTH_OTP_CODE_LENGTH,
    otpExpiryMinutes: env.AUTH_OTP_TTL_SECONDS / 60,
    timeoutMs: env.MSG91_TIMEOUT_MS,
  },
} as const;
