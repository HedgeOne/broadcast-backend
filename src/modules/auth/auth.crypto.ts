import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Refresh tokens are "<sessionId>.<secret>". The secret has 256 bits of
// entropy, so an unkeyed SHA-256 is sufficient for storage.
export function generateRefreshSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

const REFRESH_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const match = REFRESH_TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { sessionId: match[1], secret: match[2] };
}
