import { config as loadDotenv } from "dotenv";

// Runs before any application module is imported, so src/config/env.ts
// validates the test environment rather than the development one.
loadDotenv({ quiet: true });

process.env.NODE_ENV = "test";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_REDIS_URL) {
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
}

process.env.JWT_ACCESS_SECRET ??= "test-jwt-access-secret-0123456789abcdef";

// Deterministic auth settings for tests, independent of the developer's .env.
// MSG91 values are placeholders: auth tests inject a fake identity verifier
// and MSG91 verifier tests stub fetch, so no request ever reaches MSG91.
Object.assign(process.env, {
  MSG91_API_BASE_URL: "https://msg91.invalid",
  MSG91_AUTH_KEY: "test-msg91-auth-key",
  AUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
  AUTH_VERIFY_IP_LIMIT: "20",
  AUTH_VERIFY_IDENTIFIER_LIMIT: "8",
});
