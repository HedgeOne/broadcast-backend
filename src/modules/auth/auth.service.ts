import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { RateLimiter } from "../../lib/rate-limiter.js";
import { hashKeyPart } from "../../lib/rate-limiter.js";
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  parseRefreshToken,
  safeEqualHex,
} from "./auth.crypto.js";
import { authErrors } from "./auth.errors.js";
import type { AuthRepository } from "./auth.repository.js";
import {
  toPublicDevice,
  toPublicUser,
  type AccessTokenClaims,
  type AuthContext,
  type AuthTokens,
  type DeviceInfo,
  type PublicDevice,
  type PublicUser,
} from "./auth.types.js";
import {
  ChallengeStoreUnavailableError,
  OtpProviderError,
  type ChallengeStore,
  type MobileOtpProvider,
} from "./otp/index.js";

export interface AuthSettings {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  otp: {
    codeLength: number;
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
    maxResends: number;
  };
  rateLimits: {
    windowSeconds: number;
    sendPerIp: number;
    sendPerPhone: number;
    verifyPerIp: number;
    verifyPerPhone: number;
  };
}

export interface AuthServiceDeps {
  repository: AuthRepository;
  otpProvider: MobileOtpProvider;
  challengeStore: ChallengeStore;
  rateLimiter: RateLimiter;
  signAccessToken: (claims: AccessTokenClaims) => string;
  settings: AuthSettings;
  log: FastifyBaseLogger;
}

export interface PhoneChallengeResult {
  challengeId: string;
  codeLength: number;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
  resendsRemaining: number;
}

export interface PhoneResendResult {
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
  resendsRemaining: number;
}

export interface SignInResult {
  tokens: AuthTokens;
  user: PublicUser;
  device: PublicDevice;
  isNewUser: boolean;
}

// Used when the provider throttles us without saying for how long.
const PROVIDER_THROTTLE_RETRY_SECONDS = 60;

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly otpProvider: MobileOtpProvider;
  private readonly challenges: ChallengeStore;
  private readonly rateLimiter: RateLimiter;
  private readonly signAccessToken: (claims: AccessTokenClaims) => string;
  private readonly settings: AuthSettings;
  private readonly log: FastifyBaseLogger;

  constructor(deps: AuthServiceDeps) {
    this.repository = deps.repository;
    this.otpProvider = deps.otpProvider;
    this.challenges = deps.challengeStore;
    this.rateLimiter = deps.rateLimiter;
    this.signAccessToken = deps.signAccessToken;
    this.settings = deps.settings;
    this.log = deps.log;
  }

  // Sends a code to `phoneNumber` (already normalised to E.164). The answer
  // is the same whether or not an account exists for the number.
  async startPhoneSignIn(phoneNumber: string, ip: string): Promise<PhoneChallengeResult> {
    const { otp, rateLimits } = this.settings;
    await this.enforceLimit(`auth:otp:send:ip:${ip}`, rateLimits.sendPerIp);
    await this.enforceLimit(
      `auth:otp:send:phone:${hashKeyPart(phoneNumber)}`,
      rateLimits.sendPerPhone,
    );

    const waitSeconds = await this.withStore(() =>
      this.challenges.claimPhoneCooldown(phoneNumber, otp.resendCooldownSeconds),
    );
    if (waitSeconds > 0) {
      throw authErrors.rateLimited(waitSeconds);
    }

    const challenge = await this.withStore(() =>
      this.challenges.create({
        phoneNumber,
        ttlSeconds: otp.ttlSeconds,
        resendCooldownSeconds: otp.resendCooldownSeconds,
      }),
    );

    let requestId: string;
    try {
      ({ requestId } = await this.otpProvider.sendOtp(phoneNumber));
    } catch (error) {
      // Nothing was sent, so neither the challenge nor the cooldown applies.
      await Promise.allSettled([
        this.challenges.remove(challenge.id),
        this.challenges.releasePhoneCooldown(phoneNumber),
      ]);
      throw this.providerFailure(error, "send");
    }

    const attached = await this.withStore(() =>
      this.challenges.attachRequest(challenge.id, requestId),
    );
    if (!attached) {
      throw authErrors.verificationStoreUnavailable();
    }

    this.log.info({ provider: this.otpProvider.name }, "phone otp sent");

    return {
      challengeId: challenge.id,
      codeLength: otp.codeLength,
      expiresInSeconds: otp.ttlSeconds,
      resendAvailableInSeconds: otp.resendCooldownSeconds,
      resendsRemaining: otp.maxResends,
    };
  }

  async resendPhoneCode(challengeId: string, ip: string): Promise<PhoneResendResult> {
    const { otp, rateLimits } = this.settings;
    await this.enforceLimit(`auth:otp:send:ip:${ip}`, rateLimits.sendPerIp);

    const claim = await this.withStore(() =>
      this.challenges.claimResend(challengeId, otp.maxResends, otp.resendCooldownSeconds),
    );
    if (claim.status === "missing") throw authErrors.codeExpired();
    if (claim.status === "cooldown") throw authErrors.rateLimited(claim.retryAfterSeconds);
    if (claim.status === "limit") throw authErrors.resendLimitReached();

    const { challenge } = claim;
    await this.enforceLimit(
      `auth:otp:send:phone:${hashKeyPart(challenge.phoneNumber)}`,
      rateLimits.sendPerPhone,
    );

    try {
      // Re-delivers the same code; the challenge and its expiry are unchanged.
      await this.otpProvider.resendOtp(challenge.phoneNumber);
    } catch (error) {
      if (
        error instanceof OtpProviderError &&
        (error.kind === "expired" || error.kind === "exhausted")
      ) {
        await this.challenges.remove(challengeId).catch(() => undefined);
      }
      throw this.providerFailure(error, "resend");
    }

    const now = Date.now();
    return {
      expiresInSeconds: secondsUntil(challenge.expiresAt, now),
      resendAvailableInSeconds: secondsUntil(challenge.resendAvailableAt, now),
      resendsRemaining: Math.max(0, otp.maxResends - challenge.resends),
    };
  }

  // Checks the code with the provider and signs the user in. A user record
  // is created only here, after verification succeeded.
  async verifyPhoneCode(
    challengeId: string,
    code: string,
    deviceInfo: DeviceInfo,
    ip: string,
  ): Promise<SignInResult> {
    const { otp, rateLimits } = this.settings;
    await this.enforceLimit(`auth:otp:verify:ip:${ip}`, rateLimits.verifyPerIp);

    const claim = await this.withStore(() =>
      this.challenges.claimAttempt(challengeId, otp.maxAttempts),
    );
    if (claim.status !== "ok") throw authErrors.codeExpired();

    const { challenge } = claim;
    // Bounds guesses across challenges, which per-challenge attempts cannot.
    await this.enforceLimit(
      `auth:otp:verify:phone:${hashKeyPart(challenge.phoneNumber)}`,
      rateLimits.verifyPerPhone,
    );

    try {
      // The number comes from the challenge, never from the client.
      await this.otpProvider.verifyOtp(challenge.phoneNumber, code);
    } catch (error) {
      if (!(error instanceof OtpProviderError)) {
        throw this.providerFailure(error, "verify");
      }

      const attemptsRemaining = otp.maxAttempts - challenge.attempts;
      if (error.kind === "invalid_code" && attemptsRemaining > 0) {
        throw authErrors.invalidCode(attemptsRemaining);
      }
      if (error.kind === "invalid_code" || error.kind === "expired" || error.kind === "exhausted") {
        await this.challenges.remove(challengeId).catch(() => undefined);
        throw authErrors.codeExpired();
      }
      throw this.providerFailure(error, "verify");
    }

    // One challenge, one session: of concurrent successful verifications
    // only the request that deletes the challenge may continue.
    if (!(await this.withStore(() => this.challenges.consume(challengeId)))) {
      throw authErrors.codeExpired();
    }

    return this.signIn(challenge.phoneNumber, deviceInfo);
  }

  private providerFailure(error: unknown, operation: string) {
    if (!(error instanceof OtpProviderError)) {
      this.log.error(
        {
          provider: this.otpProvider.name,
          operation,
          err: error instanceof Error ? error.name : "unknown",
        },
        "unexpected otp provider failure",
      );
      return authErrors.verificationUnavailable();
    }

    // Reasons are scrubbed by the provider: no codes, tokens, keys or numbers.
    const level = error.kind === "misconfigured" ? "error" : "warn";
    this.log[level](
      { provider: error.provider, operation, kind: error.kind, reason: error.reason },
      "otp provider request failed",
    );

    switch (error.kind) {
      case "throttled":
        return authErrors.rateLimited(PROVIDER_THROTTLE_RETRY_SECONDS);
      case "expired":
      case "exhausted":
        return authErrors.codeExpired();
      case "invalid_code":
      case "unavailable":
      case "misconfigured":
        return authErrors.verificationUnavailable();
    }
  }

  private async withStore<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ChallengeStoreUnavailableError) {
        this.log.error({ err: error.message }, "otp challenge store unavailable");
        throw authErrors.verificationStoreUnavailable();
      }
      throw error;
    }
  }

  private async signIn(phoneNumber: string, deviceInfo: DeviceInfo): Promise<SignInResult> {
    const sessionId = randomUUID();
    const refreshSecret = generateRefreshSecret();
    const refreshExpiresAt = this.refreshExpiry();

    const result = await this.repository.transaction(async (repository) => {
      const { user, created } = await repository.findOrCreateVerifiedUser(phoneNumber);
      if (user.status !== "active") {
        throw authErrors.accountUnavailable();
      }

      const existingDevice = deviceInfo.deviceId
        ? await repository.findActiveDevice(deviceInfo.deviceId, user.id)
        : undefined;

      let device;
      if (existingDevice) {
        await repository.revokeSessionsForDevice(existingDevice.id);
        device = await repository.updateDevice(existingDevice.id, deviceInfo);
      } else {
        device = await repository.createDevice(user.id, deviceInfo);
      }

      await repository.createSession({
        id: sessionId,
        userId: user.id,
        deviceId: device.id,
        refreshTokenHash: hashRefreshSecret(refreshSecret),
        expiresAt: refreshExpiresAt,
      });

      return { user, device, created };
    });

    this.log.info(
      { userId: result.user.id, deviceId: result.device.id, isNewUser: result.created },
      "user authenticated",
    );

    return {
      tokens: this.issueTokens(
        { sub: result.user.id, sid: sessionId, did: result.device.id },
        formatRefreshToken(sessionId, refreshSecret),
        refreshExpiresAt,
      ),
      user: toPublicUser(result.user),
      device: toPublicDevice(result.device),
      isNewUser: result.created,
    };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      throw authErrors.invalidRefreshToken();
    }

    const session = await this.repository.findRefreshCandidate(parsed.sessionId);
    if (
      !session ||
      session.revokedAt !== null ||
      session.deviceRevokedAt !== null ||
      session.userStatus !== "active" ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw authErrors.invalidRefreshToken();
    }

    const presentedHash = hashRefreshSecret(parsed.secret);
    if (!safeEqualHex(presentedHash, session.refreshTokenHash)) {
      // A valid session id with a stale secret means an already-rotated token
      // was replayed. Treat it as theft and end the session.
      await this.repository.revokeSession(session.sessionId);
      this.log.warn(
        { sessionId: session.sessionId },
        "refresh token reuse detected; session revoked",
      );
      throw authErrors.invalidRefreshToken();
    }

    const nextSecret = generateRefreshSecret();
    const expiresAt = this.refreshExpiry();
    const rotated = await this.repository.rotateRefreshToken(
      session.sessionId,
      presentedHash,
      hashRefreshSecret(nextSecret),
      expiresAt,
    );
    if (!rotated) {
      throw authErrors.invalidRefreshToken();
    }

    await this.repository.touchDevice(session.deviceId);

    return this.issueTokens(
      { sub: session.userId, sid: session.sessionId, did: session.deviceId },
      formatRefreshToken(session.sessionId, nextSecret),
      expiresAt,
    );
  }

  async isSessionActive(claims: AccessTokenClaims): Promise<boolean> {
    return this.repository.isSessionActive(claims.sid, claims.sub, claims.did);
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.repository.revokeSession(auth.sessionId);
  }

  async logoutAll(auth: AuthContext): Promise<number> {
    return this.repository.revokeSessionsForUser(auth.userId);
  }

  async me(auth: AuthContext): Promise<{ user: PublicUser; device: PublicDevice }> {
    const [user, device] = await Promise.all([
      this.repository.findUserById(auth.userId),
      this.repository.findDeviceById(auth.deviceId),
    ]);

    if (!user || !device) {
      throw authErrors.unauthenticated();
    }

    return { user: toPublicUser(user), device: toPublicDevice(device) };
  }

  private issueTokens(claims: AccessTokenClaims, refreshToken: string, refreshExpiresAt: Date) {
    return {
      accessToken: this.signAccessToken(claims),
      accessTokenExpiresIn: this.settings.accessTokenTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.settings.refreshTokenTtlSeconds * 1000);
  }

  private async enforceLimit(key: string, limit: number): Promise<void> {
    const result = await this.rateLimiter.consume(
      key,
      limit,
      this.settings.rateLimits.windowSeconds,
    );
    if (!result.allowed) {
      throw authErrors.rateLimited(result.retryAfterSeconds);
    }
  }
}

function secondsUntil(epochMs: number, now: number): number {
  return Math.max(0, Math.ceil((epochMs - now) / 1000));
}
