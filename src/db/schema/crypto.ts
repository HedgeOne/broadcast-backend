import { sql } from "drizzle-orm";
import { bigint, foreignKey, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { devices } from "./devices.js";
import { bytea, timestamptz } from "./types.js";

// Public key material only. Private keys never leave the device.
// updated_at is maintained by the set_updated_at() trigger.
export const deviceKeys = pgTable(
  "device_keys",
  {
    deviceId: uuid("device_id").primaryKey(),

    identityKeyPublic: bytea("identity_key_public").notNull(),

    signedPrekeyPublic: bytea("signed_prekey_public"),
    signedPrekeySignature: bytea("signed_prekey_signature"),
    signedPrekeyId: bigint("signed_prekey_id", { mode: "number" }),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "device_keys_device_id_fkey",
      columns: [t.deviceId],
      foreignColumns: [devices.id],
    }).onDelete("cascade"),
  ],
);

export const oneTimePrekeys = pgTable(
  "one_time_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    deviceId: uuid("device_id").notNull(),

    keyId: bigint("key_id", { mode: "number" }).notNull(),
    publicKey: bytea("public_key").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    consumedAt: timestamptz("consumed_at"),
  },
  (t) => [
    foreignKey({
      name: "one_time_prekeys_device_id_fkey",
      columns: [t.deviceId],
      foreignColumns: [devices.id],
    }).onDelete("cascade"),

    uniqueIndex("one_time_prekeys_device_key_unique").on(t.deviceId, t.keyId),
    index("one_time_prekeys_available_idx")
      .on(t.deviceId)
      .where(sql`${t.consumedAt} IS NULL`),
  ],
);

export type DeviceKeys = typeof deviceKeys.$inferSelect;
export type NewDeviceKeys = typeof deviceKeys.$inferInsert;
export type OneTimePrekey = typeof oneTimePrekeys.$inferSelect;
export type NewOneTimePrekey = typeof oneTimePrekeys.$inferInsert;
