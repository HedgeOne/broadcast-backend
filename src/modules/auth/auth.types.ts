import type { Device, User } from "../../db/schema/index.js";

// Claims carried by access tokens. Deliberately minimal: no PII.
export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
  did: string; // device id
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string;
}

export interface DeviceInfo {
  platform: Device["platform"];
  deviceName?: string | undefined;
  appVersion?: string | undefined;
  osVersion?: string | undefined;
  // A device id previously issued to this installation; reused only if it
  // belongs to the verified user and is not revoked.
  deviceId?: string | undefined;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface PublicUser {
  id: string;
  email: string | null;
  displayName: string | null;
  username: string | null;
  dateOfBirth: string | null; // YYYY-MM-DD
}

export interface PublicDevice {
  id: string;
  platform: Device["platform"];
  name: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    username: user.username,
    dateOfBirth: user.dateOfBirth,
  };
}

export function toPublicDevice(device: Device): PublicDevice {
  return { id: device.id, platform: device.platform, name: device.deviceName };
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: AccessTokenClaims;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}
