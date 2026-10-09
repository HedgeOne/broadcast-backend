import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { RateLimiter } from "../../lib/rate-limiter.js";
import { hashKeyPart } from "../../lib/rate-limiter.js";
import type { ReplayGuard } from "../../lib/replay-guard.js";
import {
  fingerprintProviderToken,
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
import { identifierFromVerified, type Identifier } from "./identifiers.js";
import {
  IdentityTokenRejectedError,
  type IdentityVerifier,
  type VerificationChannel,
  type VerifiedIdentity,
} from "./verification/index.js";

// Long enough to outlive any MSG91 widget access token.
const PROVIDER_TOKEN_REPLAY_TTL_SECONDS = 24 * 60 * 60;

export interface AuthSettings {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rateLimits: {
    verify: { windowSeconds: number; perIp: number; perIdentifier: number };
  };
}

export interface AuthServiceDeps {
  repository: AuthRepository;
  identityVerifier: IdentityVerifier;
  rateLimiter: RateLimiter;
  replayGuard: ReplayGuard;
  signAccessToken: (claims: AccessTokenClaims) => string;
  settings: AuthSettings;
  log: FastifyBaseLogger;
}

export interface SignInResult {
  tokens: AuthTokens;
  user: PublicUser;
  device: PublicDevice;
  isNewUser: boolean;
}

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly verifier: IdentityVerifier;
  private readonly rateLimiter: RateLimiter;
  private readonly replayGuard: ReplayGuard;
  private readonly signAccessToken: (claims: AccessTokenClaims) => string;
  private readonly settings: AuthSettings;
  private readonly log: FastifyBaseLogger;

  constructor(deps: AuthServiceDeps) {
    this.repository = deps.repository;
    this.verifier = deps.identityVerifier;
    this.rateLimiter = deps.rateLimiter;
    this.replayGuard = deps.replayGuard;
    this.signAccessToken = deps.signAccessToken;
    this.settings = deps.settings;
    this.log = deps.log;
  }

  // Signs in with an email the provider has already verified. The email is
  // taken only from the provider's answer, never from the client.
  async verifyEmail(
    providerAccessToken: string,
    deviceInfo: DeviceInfo,
    ip: string,
  ): Promise<SignInResult> {
    const limits = this.settings.rateLimits.verify;
    await this.enforceLimit(`auth:verify:ip:${ip}`, limits.perIp, limits.windowSeconds);

    const identity = await this.verifyWithProvider(providerAccessToken, "email");
    const identifier = identifierFromVerified(identity);

    await this.enforceLimit(
      `auth:verify:id:${identifier.type}:${hashKeyPart(identifier.value)}`,
      limits.perIdentifier,
      limits.windowSeconds,
    );

    // One provider token, one session: a replayed token cannot mint more.
    const fresh = await this.replayGuard.claim(
      `auth:provider-token:${fingerprintProviderToken(providerAccessToken)}`,
      PROVIDER_TOKEN_REPLAY_TTL_SECONDS,
    );
    if (!fresh) {
      this.log.warn({ provider: this.verifier.name }, "provider access token replayed");
      throw authErrors.verificationFailed();
    }

    return this.signIn(identifier, deviceInfo);
  }

  private async verifyWithProvider(
    providerAccessToken: string,
    expected: VerificationChannel,
  ): Promise<VerifiedIdentity> {
    let identity: VerifiedIdentity;
    try {
      identity = await this.verifier.verifyAccessToken(providerAccessToken);
    } catch (error) {
      const rejected = error instanceof IdentityTokenRejectedError;
      // Provider reasons are logged; tokens and identifiers never are.
      this.log.warn(
        {
          provider: this.verifier.name,
          reason: error instanceof Error ? error.message : "unexpected error",
        },
        rejected ? "provider rejected access token" : "identity provider unavailable",
      );
      throw rejected ? authErrors.verificationFailed() : authErrors.verificationUnavailable();
    }

    if (identity.channel !== expected) {
      this.log.warn(
        { provider: this.verifier.name, channel: identity.channel, expected },
        "provider token proves an unexpected channel",
      );
      throw authErrors.verificationFailed();
    }

    return identity;
  }

  private async signIn(identifier: Identifier, deviceInfo: DeviceInfo): Promise<SignInResult> {
    const sessionId = randomUUID();
    const refreshSecret = generateRefreshSecret();
    const refreshExpiresAt = this.refreshExpiry();

    const result = await this.repository.transaction(async (repository) => {
      const { user, created } = await repository.findOrCreateVerifiedUser(identifier);
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

  private async enforceLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const result = await this.rateLimiter.consume(key, limit, windowSeconds);
    if (!result.allowed) {
      throw authErrors.rateLimited(result.retryAfterSeconds);
    }
  }
}
