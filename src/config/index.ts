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

    rateLimits: {
      verify: {
        windowSeconds: env.AUTH_VERIFY_WINDOW_SECONDS,
        perIp: env.AUTH_VERIFY_IP_LIMIT,
        perIdentifier: env.AUTH_VERIFY_IDENTIFIER_LIMIT,
      },
    },
  },

  msg91: {
    apiBaseUrl: env.MSG91_API_BASE_URL,
    authKey: env.MSG91_AUTH_KEY,
    timeoutMs: env.MSG91_TIMEOUT_MS,
  },
} as const;
