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

  // Phone OTP challenges (Redis). MSG91 generates codes of this length that
  // expire with the challenge; its expiry is set in whole minutes.
  AUTH_OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(9).default(6),
  AUTH_OTP_TTL_SECONDS: positiveInt
    .max(10_080 * 60)
    .refine((seconds) => seconds % 60 === 0, "must be a whole number of minutes")
    .default(900),
  AUTH_OTP_MAX_ATTEMPTS: positiveInt.default(5),
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: positiveInt.default(30),
  // MSG91 allows at most 2 retries per code.
  AUTH_OTP_MAX_RESENDS: z.coerce.number().int().min(0).max(2).default(2),

  // Fixed-window rate limits (Redis) for the phone OTP endpoints. "Send"
  // covers start and resend.
  AUTH_OTP_RATE_WINDOW_SECONDS: positiveInt.default(3600),
  AUTH_OTP_SEND_IP_LIMIT: positiveInt.default(30),
  AUTH_OTP_SEND_PHONE_LIMIT: positiveInt.default(8),
  AUTH_OTP_VERIFY_IP_LIMIT: positiveInt.default(60),
  AUTH_OTP_VERIFY_PHONE_LIMIT: positiveInt.default(15),

  // Contact matching (POST /contacts/match). Numbers are processed in
  // memory only; these bound how much of the number space one account or
  // address can probe per window.
  CONTACTS_MATCH_MAX_BATCH: z.coerce.number().int().min(1).max(1000).default(500),
  CONTACTS_MATCH_WINDOW_SECONDS: positiveInt.default(3600),
  CONTACTS_MATCH_USER_REQUEST_LIMIT: positiveInt.default(60),
  CONTACTS_MATCH_IP_REQUEST_LIMIT: positiveInt.default(60),
  CONTACTS_MATCH_USER_NUMBER_LIMIT: positiveInt.default(20000),
  CONTACTS_MATCH_QUERY_TIMEOUT_MS: positiveInt.default(3000),

  // Including the owner.
  GROUP_MAX_MEMBERS: z.coerce.number().int().min(2).max(1024).default(256),

  // MSG91 SendOTP V5 API, called only from the backend. None of these may
  // reach the mobile app.
  MSG91_API_BASE_URL: z.url().default("https://control.msg91.com"),
  MSG91_AUTH_KEY: required,
  MSG91_OTP_TEMPLATE_ID: required,
  MSG91_TIMEOUT_MS: positiveInt.default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Only variable names and messages are printed; values may be secrets.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

export const env = parseEnv(process.env);
