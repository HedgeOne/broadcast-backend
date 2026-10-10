import { and, eq, sql } from "drizzle-orm";

import { config } from "../../config/index.js";
import { closeDatabase, db } from "../client.js";
import {
  broadcastListMembers,
  broadcastLists,
  chatMembers,
  chats,
  groups,
  users,
} from "../schema/index.js";
import { assertLocalDatabase, describeDatabase } from "./local-database.js";

// +1 555-01xx is reserved for fictional use.
const SEED_USERS = [
  { phoneNumber: "+15555550101", displayName: "Alice (dev)", username: "alice_dev" },
  { phoneNumber: "+15555550102", displayName: "Bob (dev)", username: "bob_dev" },
  { phoneNumber: "+15555550103", displayName: "Charlie (dev)", username: "charlie_dev" },
] as const;

const SEED_GROUP_NAME = "Dev Group";
const SEED_BROADCAST_LIST_NAME = "Dev Broadcast List";

async function seed(): Promise<void> {
  await db.transaction(async (tx) => {
    const seeded = await tx
      .insert(users)
      .values(SEED_USERS.map((user) => ({ ...user, phoneNumberVerifiedAt: new Date() })))
      .onConflictDoUpdate({
        target: users.phoneNumber,
        set: { displayName: sql`excluded.display_name` },
      })
      .returning({ id: users.id, phoneNumber: users.phoneNumber });

    const idFor = (phoneNumber: string): string => {
      const user = seeded.find((row) => row.phoneNumber === phoneNumber);
      if (!user) {
        throw new Error(`Seed user ${phoneNumber} was not created`);
      }
      return user.id;
    };

    const alice = idFor(SEED_USERS[0].phoneNumber);
    const bob = idFor(SEED_USERS[1].phoneNumber);
    const charlie = idFor(SEED_USERS[2].phoneNumber);

    const [existingDirect] = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(
        and(
          eq(chats.type, "direct"),
          sql`LEAST(${chats.directUserAId}, ${chats.directUserBId}) = LEAST(${alice}::uuid, ${bob}::uuid)`,
          sql`GREATEST(${chats.directUserAId}, ${chats.directUserBId}) = GREATEST(${alice}::uuid, ${bob}::uuid)`,
        ),
      );

    if (!existingDirect) {
      const [direct] = await tx
        .insert(chats)
        .values({ type: "direct", createdBy: alice, directUserAId: alice, directUserBId: bob })
        .returning({ id: chats.id });

      if (!direct) throw new Error("Failed to create direct chat");

      await tx.insert(chatMembers).values([
        { chatId: direct.id, userId: alice },
        { chatId: direct.id, userId: bob },
      ]);
      console.log("created direct chat: Alice <-> Bob");
    }

    const [existingGroup] = await tx
      .select({ chatId: groups.chatId })
      .from(groups)
      .innerJoin(chats, eq(chats.id, groups.chatId))
      .where(and(eq(groups.name, SEED_GROUP_NAME), eq(chats.createdBy, alice)));

    if (!existingGroup) {
      const [groupChat] = await tx
        .insert(chats)
        .values({ type: "group", createdBy: alice })
        .returning({ id: chats.id });

      if (!groupChat) throw new Error("Failed to create group chat");

      await tx.insert(groups).values({ chatId: groupChat.id, name: SEED_GROUP_NAME });
      await tx.insert(chatMembers).values([
        { chatId: groupChat.id, userId: alice, role: "owner" },
        { chatId: groupChat.id, userId: bob },
        { chatId: groupChat.id, userId: charlie },
      ]);
      console.log(`created group: ${SEED_GROUP_NAME}`);
    }

    const [existingList] = await tx
      .select({ id: broadcastLists.id })
      .from(broadcastLists)
      .where(
        and(eq(broadcastLists.ownerId, alice), eq(broadcastLists.name, SEED_BROADCAST_LIST_NAME)),
      );

    if (!existingList) {
      const [list] = await tx
        .insert(broadcastLists)
        .values({ ownerId: alice, name: SEED_BROADCAST_LIST_NAME })
        .returning({ id: broadcastLists.id });

      if (!list) throw new Error("Failed to create broadcast list");

      await tx.insert(broadcastListMembers).values([
        { broadcastListId: list.id, userId: bob },
        { broadcastListId: list.id, userId: charlie },
      ]);
      console.log(`created broadcast list: ${SEED_BROADCAST_LIST_NAME}`);
    }
  });
}

try {
  assertLocalDatabase(config.database.url, "seed the database");
  await seed();
  console.log(`Seed complete for ${describeDatabase(config.database.url)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
