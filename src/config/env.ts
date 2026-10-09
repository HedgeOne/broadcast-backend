import "dotenv/config";

import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const secret = z.string().min(32, "must be at least 32 characters");
const required = z.string().trim().min(1, "is required");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  // Set to true behind a load balancer so request.ip is the client address.
  TRUST_PROXY: z.stringbool().default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(20),
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  TEST_REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),

  // Tokens
  JWT_ACCESS_SECRET: secret,
  AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt.default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: positiveInt.default(60 * 60 * 24 * 30),

  // Rate limits for /auth/email/verify (fixed windows, Redis-backed).
  // OTP send/resend/attempt limits are configured on the MSG91 widget.
  AUTH_VERIFY_WINDOW_SECONDS: positiveInt.default(900),
  AUTH_VERIFY_IP_LIMIT: positiveInt.default(30),
  AUTH_VERIFY_IDENTIFIER_LIMIT: positiveInt.default(15),

  // MSG91 (backend only). The auth key verifies widget access tokens and must
  // never reach the mobile app.
  MSG91_API_BASE_URL: z.url().default("https://control.msg91.com"),
  MSG91_AUTH_KEY: required,
  MSG91_TIMEOUT_MS: positiveInt.default(10_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Only variable names and messages are printed; values may be secrets.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

export const env = loadEnv();
