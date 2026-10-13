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

  // Recipients per broadcast list (WhatsApp's documented limit is 256).
  BROADCAST_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(1024).default(256),
  // How often accepted broadcasts with undelivered recipients (e.g. after a
  // restart) are re-driven. 0 disables the sweep.
  BROADCAST_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),

  // Private S3 bucket for message media. Credentials come from the AWS SDK's
  // default provider chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY locally,
  // an IAM role in production) and are never read into app config. Without
  // a bucket, media endpoints answer 503.
  AWS_REGION: z.string().trim().min(1).default("ap-south-1"),
  AWS_S3_BUCKET: z.string().trim().min(3).optional(),
  // Largest file a client may upload. 15 MB is the product limit; the cap
  // stops a misconfiguration from silently raising it.
  MEDIA_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(15 * 1024 * 1024)
    .default(15 * 1024 * 1024),
  // Lifetime of a presigned upload (PUT) URL; long enough for a 15 MB
  // upload on a slow mobile connection.
  MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  // Lifetime of a presigned download (GET) URL; clients fetch a new one
  // when it expires.
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // Finalized uploads not attached to a message within this window are
  // deleted.
  MEDIA_UNATTACHED_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(24 * 3600),
  // How often abandoned and unreferenced objects are cleaned up. 0 disables.
  MEDIA_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(10 * 60_000),

  // Push notifications through the Expo Push Service (which forwards to
  // APNs and FCM). The access token is only needed when "enhanced push
  // security" is enabled for the Expo project; it stays on the backend.
  EXPO_PUSH_API_URL: z.url({ protocol: /^https?$/ }).default("https://exp.host/--/api/v2/push"),
  EXPO_ACCESS_TOKEN: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional(),
  PUSH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  // How often due notification jobs and push receipts are processed (jobs
  // are also processed right after a message commits). 0 disables.
  PUSH_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
  // Attempts per device before a push is given up, with exponential
  // backoff between them.
  PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  // Notifications not accepted by the provider within this age are dropped
  // rather than delivered late; this also bounds the queue during an outage.
  PUSH_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(24 * 3600)
    .default(3600),
  // Expo recommends fetching receipts about 15 minutes after sending.
  PUSH_RECEIPT_DELAY_SECONDS: z.coerce.number().int().min(0).max(86_400).default(900),

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
