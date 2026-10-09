import jwt from "@fastify/jwt";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { config } from "../../config/index.js";
import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { redisReplayGuard, type ReplayGuard } from "../../lib/replay-guard.js";
import { authErrors } from "./auth.errors.js";
import { AuthRepository } from "./auth.repository.js";
import { authRoutes } from "./auth.routes.js";
import { AuthService } from "./auth.service.js";
import type { AccessTokenClaims, AuthContext } from "./auth.types.js";
import { createIdentityVerifier, type IdentityVerifier } from "./verification/index.js";

export type { AuthContext } from "./auth.types.js";

export interface AuthModuleOptions {
  identityVerifier?: IdentityVerifier;
  rateLimiter?: RateLimiter;
  replayGuard?: ReplayGuard;
}

function isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.sub === "string" &&
    typeof claims.sid === "string" &&
    typeof claims.did === "string"
  );
}

// Not encapsulated, so `app.authenticate` is available to every module.
export const authModule = fp<AuthModuleOptions>(
  async (app, options) => {
    await app.register(jwt, {
      secret: config.auth.jwtAccessSecret,
      sign: { algorithm: "HS256", expiresIn: `${config.auth.accessTokenTtlSeconds}s` },
      verify: { algorithms: ["HS256"] },
    });

    const service = new AuthService({
      repository: new AuthRepository(db),
      identityVerifier: options.identityVerifier ?? createIdentityVerifier(),
      rateLimiter: options.rateLimiter ?? redisRateLimiter,
      replayGuard: options.replayGuard ?? redisReplayGuard,
      signAccessToken: (claims) => app.jwt.sign(claims),
      settings: config.auth,
      log: app.log,
    });

    app.decorateRequest("auth", null as unknown as AuthContext);

    app.decorate("authenticate", async (request: FastifyRequest) => {
      let claims: unknown;
      try {
        claims = await request.jwtVerify();
      } catch {
        throw authErrors.unauthenticated();
      }

      // A valid signature is not enough: the session must still be live so
      // logout and revocation take effect before the token expires.
      if (!isAccessTokenClaims(claims) || !(await service.isSessionActive(claims))) {
        throw authErrors.unauthenticated();
      }

      request.auth = { userId: claims.sub, sessionId: claims.sid, deviceId: claims.did };
    });

    await app.register(authRoutes, { prefix: "/auth", service });
  },
  { name: "auth" },
);
