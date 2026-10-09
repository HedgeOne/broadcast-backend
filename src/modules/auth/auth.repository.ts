import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { devices, sessions, users, type Device, type User } from "../../db/schema/index.js";
import type { DeviceInfo } from "./auth.types.js";
import type { Identifier } from "./identifiers.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

export interface NewSession {
  id: string;
  userId: string;
  deviceId: string;
  refreshTokenHash: string;
  expiresAt: Date;
}

export interface RefreshCandidate {
  sessionId: string;
  userId: string;
  deviceId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userStatus: User["status"];
  deviceRevokedAt: Date | null;
}

export class AuthRepository {
  constructor(private readonly db: Executor) {}

  async transaction<T>(fn: (repository: AuthRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new AuthRepository(tx)));
  }

  // ---- Users --------------------------------------------------------------

  // Called only after the provider has proven ownership of `identifier`, so
  // the matching *_verified_at column is stamped for new and existing users.
  async findOrCreateVerifiedUser(
    identifier: Identifier,
  ): Promise<{ user: User; created: boolean }> {
    const isEmail = identifier.type === "email";
    const target = isEmail ? users.email : users.phoneNumber;
    const verifiedAt = isEmail ? users.emailVerifiedAt : users.phoneNumberVerifiedAt;
    const values = isEmail
      ? { email: identifier.value, emailVerifiedAt: sql`now()` }
      : { phoneNumber: identifier.value, phoneNumberVerifiedAt: sql`now()` };

    const [created] = await this.db
      .insert(users)
      .values(values)
      .onConflictDoNothing({ target })
      .returning();

    if (created) {
      return { user: created, created: true };
    }

    const [existing] = await this.db
      .update(users)
      .set(
        isEmail
          ? { emailVerifiedAt: sql`coalesce(${verifiedAt}, now())` }
          : { phoneNumberVerifiedAt: sql`coalesce(${verifiedAt}, now())` },
      )
      .where(eq(target, identifier.value))
      .returning();
    if (!existing) {
      throw new Error("User vanished between insert conflict and update");
    }

    return { user: existing, created: false };
  }

  async findUserById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }

  // ---- Devices ------------------------------------------------------------

  async findActiveDevice(deviceId: string, userId: string): Promise<Device | undefined> {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)));
    return device;
  }

  async findDeviceById(deviceId: string): Promise<Device | undefined> {
    const [device] = await this.db.select().from(devices).where(eq(devices.id, deviceId));
    return device;
  }

  async createDevice(userId: string, info: DeviceInfo): Promise<Device> {
    const [device] = await this.db
      .insert(devices)
      .values({
        userId,
        platform: info.platform,
        deviceName: info.deviceName ?? null,
        appVersion: info.appVersion ?? null,
        osVersion: info.osVersion ?? null,
        lastActiveAt: sql`now()`,
      })
      .returning();

    if (!device) throw new Error("Failed to create device");
    return device;
  }

  async updateDevice(deviceId: string, info: DeviceInfo): Promise<Device> {
    const [device] = await this.db
      .update(devices)
      .set({
        platform: info.platform,
        deviceName: info.deviceName ?? null,
        appVersion: info.appVersion ?? null,
        osVersion: info.osVersion ?? null,
        lastActiveAt: sql`now()`,
      })
      .where(eq(devices.id, deviceId))
      .returning();

    if (!device) throw new Error("Failed to update device");
    return device;
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ lastActiveAt: sql`now()` })
      .where(eq(devices.id, deviceId));
  }

  // ---- Sessions -----------------------------------------------------------

  async createSession(session: NewSession): Promise<void> {
    await this.db.insert(sessions).values(session);
  }

  async findRefreshCandidate(sessionId: string): Promise<RefreshCandidate | undefined> {
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        deviceId: sessions.deviceId,
        refreshTokenHash: sessions.refreshTokenHash,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        userStatus: users.status,
        deviceRevokedAt: devices.revokedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(eq(sessions.id, sessionId));

    return row;
  }

  // Compare-and-swap so only one concurrent refresh with the same token wins.
  async rotateRefreshToken(
    sessionId: string,
    expectedHash: string,
    nextHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ refreshTokenHash: nextHash, expiresAt, lastUsedAt: sql`now()` })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.refreshTokenHash, expectedHash),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    return rows.length === 1;
  }

  async isSessionActive(sessionId: string, userId: string, deviceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          eq(sessions.deviceId, deviceId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
          eq(users.status, "active"),
          isNull(devices.revokedAt),
        ),
      );

    return row !== undefined;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeSessionsForDevice(deviceId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)));
  }

  async revokeSessionsForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.length;
  }
}
