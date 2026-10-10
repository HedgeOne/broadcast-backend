import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import {
  bearer,
  closeConnections,
  createTestApp,
  resetState,
  type TestContext,
} from "./helpers/auth.js";
import {
  api,
  createUser,
  encodeText,
  nextEvent,
  openChat,
  sendText,
  type TestUser,
} from "./helpers/messaging.js";

afterAll(closeConnections);

const MAX_MEMBERS = 5;

interface Member {
  userId: string;
  role: "owner" | "admin" | "member";
  displayName: string | null;
}

interface GroupBody {
  chatId: string;
  name: string;
  description: string | null;
  myRole: string;
  settings: Record<string, boolean>;
  members: Member[];
  invite: { useCount: number; maxUses: number | null } | null;
  pendingRequests: { userId: string }[] | null;
}

interface SystemBody {
  kind: string;
  actorId: string;
  userId?: string;
  userIds?: string[];
  approvedBy?: string | null;
  names: Record<string, string | null>;
}

interface MessageBody {
  id: string;
  sequence: number;
  senderId: string;
  type: string;
  ciphertext: string;
  mentions: string[];
  reactions: { userId: string; emoji: string }[];
  replyTo: { id: string; available: boolean; ciphertext: string | null } | null;
  system: SystemBody | null;
  deleted: boolean;
  deletedBy: string | null;
}

interface SummaryBody {
  id: string;
  type: "direct" | "group";
  group?: { name: string; memberCount: number; myRole: string; settings: Record<string, boolean> };
  lastMessage: MessageBody | null;
  lastSenderName: string | null;
  lastSequence: number;
  unreadCount: number;
  peerDeliveredSequence: number;
  peerReadSequence: number | null;
}

describe("groups", () => {
  let ctx: TestContext;
  let ana: TestUser;
  let ben: TestUser;
  let cara: TestUser;
  let dev: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp({ chats: { groupMaxMembers: MAX_MEMBERS } });
    await ctx.app.realtimeHub.ready();
  });

  beforeEach(async () => {
    await resetState();
    ana = await createUser(ctx, "ana", { displayName: "Ana" });
    ben = await createUser(ctx, "ben", { displayName: "Ben" });
    cara = await createUser(ctx, "cara", { displayName: "Cara" });
    dev = await createUser(ctx, "dev", { displayName: "Dev" });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function create(owner: TestUser, members: TestUser[], extra: Record<string, unknown> = {}) {
    return api(ctx, owner, "POST", "/groups", {
      clientRequestId: randomUUID(),
      name: "Weekend plans",
      memberIds: members.map((member) => member.user.id),
      ...extra,
    });
  }

  async function createGroup(owner: TestUser, members: TestUser[]): Promise<string> {
    const response = await create(owner, members);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ chat: { id: string } }>().chat.id;
  }

  async function details(user: TestUser, chatId: string): Promise<GroupBody> {
    const response = await api(ctx, user, "GET", `/groups/${chatId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ group: GroupBody }>().group;
  }

  async function history(user: TestUser, chatId: string): Promise<MessageBody[]> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}/messages`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ messages: MessageBody[] }>().messages;
  }

  async function summary(user: TestUser, chatId: string): Promise<SummaryBody> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ chat: SummaryBody }>().chat;
  }

  async function chatList(user: TestUser): Promise<SummaryBody[]> {
    const response = await api(ctx, user, "GET", "/chats");
    expect(response.statusCode).toBe(200);
    return response.json<{ chats: SummaryBody[] }>().chats;
  }

  async function settings(user: TestUser, chatId: string, changes: Record<string, boolean>) {
    return api(ctx, user, "PATCH", `/groups/${chatId}/settings`, changes);
  }

  async function promote(owner: TestUser, chatId: string, user: TestUser) {
    const response = await api(
      ctx,
      owner,
      "PUT",
      `/groups/${chatId}/members/${user.user.id}/role`,
      {
        role: "admin",
      },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function systemKinds(user: TestUser, chatId: string): Promise<string[]> {
    return (await history(user, chatId)).flatMap((message) =>
      message.system ? [message.system.kind] : [],
    );
  }

  function connect(user: TestUser) {
    return ctx.app.injectWS("/ws", { headers: bearer(user.accessToken) });
  }

  async function sendWith(
    user: TestUser,
    chatId: string,
    text: string,
    extra: Record<string, unknown>,
  ) {
    return api(ctx, user, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: randomUUID(),
      type: "text",
      ciphertext: encodeText(text),
      ...extra,
    });
  }

  async function enableInvites(
    owner: TestUser,
    chatId: string,
    extra: Record<string, boolean> = {},
  ) {
    expect((await settings(owner, chatId, { inviteLinksEnabled: true, ...extra })).statusCode).toBe(
      200,
    );
    const response = await api(ctx, owner, "POST", `/groups/${chatId}/invite`, {});
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ token: string }>().token;
  }

  describe("authentication", () => {
    it.each([
      ["POST", "/groups"],
      ["GET", `/groups/${randomUUID()}`],
      ["GET", "/invites/abc"],
    ] as const)("rejects %s %s without a session", async (method, url) => {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("creation", () => {
    it("creates the group atomically with the creator as owner", async () => {
      const response = await create(ana, [ben, cara], { description: "  Saturday  " });
      expect(response.statusCode, response.body).toBe(201);
      const chat = response.json<{ chat: SummaryBody }>().chat;
      expect(chat.type).toBe("group");
      expect(chat.group).toMatchObject({ name: "Weekend plans", memberCount: 3, myRole: "owner" });

      const group = await details(ana, chat.id);
      expect(group.description).toBe("Saturday");
      expect(group.members.map((member) => [member.displayName, member.role])).toEqual([
        ["Ana", "owner"],
        ["Ben", "member"],
        ["Cara", "member"],
      ]);
      expect(group.invite).toBeNull();
      expect(group.pendingRequests).toEqual([]);
      // Non-admins don't see invite or request data.
      expect((await details(ben, chat.id)).pendingRequests).toBeNull();

      const [created] = await history(ben, chat.id);
      expect(created?.type).toBe("system");
      expect(created?.ciphertext).toBe("");
      expect(created?.system).toMatchObject({
        kind: "group.created",
        actorId: ana.user.id,
        userIds: [ben.user.id, cara.user.id],
        names: { [ana.user.id]: "Ana", [ben.user.id]: "Ben" },
      });
    });

    it("shows the group in every member's chat list, but not to others", async () => {
      const chatId = await createGroup(ana, [ben]);
      await sendText(ctx, ben, chatId, "hi all");

      const [row] = await chatList(ana);
      expect(row).toMatchObject({
        id: chatId,
        type: "group",
        lastSenderName: "Ben",
        unreadCount: 1,
      });
      expect((await chatList(ben))[0]?.unreadCount).toBe(0);
      expect(await chatList(cara)).toEqual([]);
    });

    it("is idempotent per client request ID", async () => {
      const clientRequestId = randomUUID();
      const payload = { clientRequestId, name: "Once", memberIds: [ben.user.id] };
      const first = await api(ctx, ana, "POST", "/groups", payload);
      const second = await api(ctx, ana, "POST", "/groups", payload);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json<{ chat: { id: string } }>().chat.id).toBe(
        first.json<{ chat: { id: string } }>().chat.id,
      );

      const { rows } = await pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM chats WHERE type = 'group'",
      );
      expect(rows[0]?.n).toBe(1);
    });

    it("converges concurrent retries on one group", async () => {
      const payload = { clientRequestId: randomUUID(), name: "Race", memberIds: [ben.user.id] };
      const responses = await Promise.all([
        api(ctx, ana, "POST", "/groups", payload),
        api(ctx, ana, "POST", "/groups", payload),
      ]);
      const ids = new Set(
        responses.map((response) => response.json<{ chat: { id: string } }>().chat.id),
      );
      expect(ids.size).toBe(1);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    });

    it("rolls everything back when any part of creation fails", async () => {
      await pool.query(`
        CREATE FUNCTION test_fail_system_message() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced failure'; END $$;
        CREATE TRIGGER test_fail_system_message BEFORE INSERT ON messages
          FOR EACH ROW WHEN (NEW.type = 'system') EXECUTE FUNCTION test_fail_system_message();
      `);
      try {
        const response = await create(ana, [ben]);
        expect(response.statusCode).toBe(500);
      } finally {
        await pool.query(`
          DROP TRIGGER test_fail_system_message ON messages;
          DROP FUNCTION test_fail_system_message();
        `);
      }
      const counts = await pool.query<{ chats: number; groups: number; members: number }>(`
        SELECT (SELECT COUNT(*) FROM chats)::int AS chats,
               (SELECT COUNT(*) FROM groups)::int AS groups,
               (SELECT COUNT(*) FROM chat_members)::int AS members
      `);
      expect(counts.rows[0]).toEqual({ chats: 0, groups: 0, members: 0 });
    });

    it("validates the name and participants", async () => {
      expect((await create(ana, [ben], { name: "   " })).statusCode).toBe(400);
      expect((await create(ana, [ben], { name: "x".repeat(101) })).statusCode).toBe(400);
      expect((await create(ana, [])).statusCode).toBe(400);

      const selfOnly = await create(ana, [ana]);
      expect(selfOnly.statusCode).toBe(400);
      expect(selfOnly.json<{ error: { code: string } }>().error.code).toBe("INVALID_PARTICIPANTS");

      const unknown = await api(ctx, ana, "POST", "/groups", {
        clientRequestId: randomUUID(),
        name: "x",
        memberIds: [randomUUID()],
      });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe(
        "PARTICIPANTS_UNAVAILABLE",
      );
    });

    it("never reveals a block and respects group-add privacy", async () => {
      await api(ctx, ben, "PUT", `/privacy/blocks/${ana.user.id}`);
      const blockedByBen = await create(ana, [ben]);
      expect(blockedByBen.statusCode).toBe(422);
      expect(blockedByBen.json<{ error: { code: string } }>().error.code).toBe(
        "PARTICIPANTS_UNAVAILABLE",
      );

      await api(ctx, ana, "PUT", `/privacy/blocks/${cara.user.id}`);
      const anaBlocked = await create(ana, [cara]);
      expect(anaBlocked.json<{ error: { code: string } }>().error.code).toBe(
        "PARTICIPANTS_BLOCKED",
      );

      await pool.query(
        `INSERT INTO privacy_settings (user_id, allow_group_invites) VALUES ($1, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET allow_group_invites = FALSE`,
        [dev.user.id],
      );
      const noAdds = await create(ana, [dev]);
      expect(noAdds.json<{ error: { code: string } }>().error.code).toBe(
        "PARTICIPANTS_UNAVAILABLE",
      );

      const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM chats");
      expect(rows[0]?.n).toBe(0);
    });

    it("enforces the member limit", async () => {
      const extra = await Promise.all([createUser(ctx, "e1"), createUser(ctx, "e2")]);
      const response = await create(ana, [ben, cara, dev, ...extra]);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("GROUP_FULL");
    });
  });

  describe("access", () => {
    it("looks identical to a missing group for non-members", async () => {
      const chatId = await createGroup(ana, [ben]);
      for (const [method, url] of [
        ["GET", `/groups/${chatId}`],
        ["GET", `/chats/${chatId}`],
        ["GET", `/chats/${chatId}/messages`],
        ["PATCH", `/groups/${chatId}/settings`],
      ] as const) {
        const response = await api(
          ctx,
          cara,
          method,
          url,
          method === "PATCH" ? { approvalRequired: true } : undefined,
        );
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await sendText(ctx, cara, chatId, "sneak")).statusCode).toBe(404);
    });
  });

  describe("info and settings", () => {
    it("lets members edit info unless restricted to admins", async () => {
      const chatId = await createGroup(ana, [ben]);
      const edit = await api(ctx, ben, "PATCH", `/groups/${chatId}`, {
        name: "Renamed",
        description: "",
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json<{ group: GroupBody }>().group).toMatchObject({
        name: "Renamed",
        description: null,
      });

      expect((await settings(ana, chatId, { onlyAdminsCanEditInfo: true })).statusCode).toBe(200);
      const denied = await api(ctx, ben, "PATCH", `/groups/${chatId}`, { name: "Nope" });
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe("GROUP_FORBIDDEN");

      expect(await systemKinds(ana, chatId)).toEqual([
        "group.created",
        "info.changed",
        "settings.changed",
      ]);
    });

    it("only lets admins change settings, and ignores no-op changes", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      expect((await settings(ben, chatId, { onlyAdminsCanMessage: true })).statusCode).toBe(403);
      await promote(ana, chatId, ben);
      const changed = await settings(ben, chatId, {
        onlyAdminsCanMessage: true,
        approvalRequired: false,
      });
      expect(changed.json<{ group: GroupBody }>().group.settings.onlyAdminsCanMessage).toBe(true);

      const events = (await history(ana, chatId)).filter(
        (message) => message.system?.kind === "settings.changed",
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.system).toMatchObject({ changes: { onlyAdminsCanMessage: true } });

      expect((await settings(ana, chatId, { unknownSetting: true })).statusCode).toBe(400);
    });

    it("blocks members from sending when only admins can message", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await promote(ana, chatId, cara);
      await settings(ana, chatId, { onlyAdminsCanMessage: true });

      const denied = await sendText(ctx, ben, chatId, "hello?");
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe("ONLY_ADMINS_CAN_SEND");
      expect((await sendText(ctx, cara, chatId, "admin here")).statusCode).toBe(201);
      expect((await summary(ben, chatId)).group?.settings.onlyAdminsCanMessage).toBe(true);
    });
  });

  describe("membership", () => {
    it("adds members subject to permissions, duplicates and capacity", async () => {
      const chatId = await createGroup(ana, [ben]);
      const byMember = await api(ctx, ben, "POST", `/groups/${chatId}/members`, {
        userIds: [cara.user.id],
      });
      expect(byMember.statusCode).toBe(403);

      const added = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: [cara.user.id],
      });
      expect(added.statusCode).toBe(200);
      expect(added.json<{ group: GroupBody }>().group.members).toHaveLength(3);

      const duplicate = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: [cara.user.id, dev.user.id],
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("ALREADY_MEMBER");

      await settings(ana, chatId, { onlyAdminsCanAddMembers: false });
      expect(
        (await api(ctx, ben, "POST", `/groups/${chatId}/members`, { userIds: [dev.user.id] }))
          .statusCode,
      ).toBe(200);

      const extra = await Promise.all([createUser(ctx, "e1"), createUser(ctx, "e2")]);
      const full = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: extra.map((user) => user.user.id),
      });
      expect(full.json<{ error: { code: string } }>().error.code).toBe("GROUP_FULL");
      expect(await systemKinds(ana, chatId)).toEqual([
        "group.created",
        "members.added",
        "settings.changed",
        "members.added",
      ]);
    });

    it("hides earlier history from new members unless the group shares it", async () => {
      const chatId = await createGroup(ana, [ben]);
      await sendText(ctx, ana, chatId, "before cara");
      await api(ctx, ana, "POST", `/groups/${chatId}/members`, { userIds: [cara.user.id] });

      const caraView = await history(cara, chatId);
      expect(caraView.map((message) => message.system?.kind ?? "text")).toEqual(["members.added"]);
      expect((await summary(cara, chatId)).unreadCount).toBe(0);

      await settings(ana, chatId, { historyVisibleToNewMembers: true });
      await api(ctx, ana, "POST", `/groups/${chatId}/members`, { userIds: [dev.user.id] });
      expect((await history(dev, chatId)).some((message) => message.type === "text")).toBe(true);
      expect((await summary(dev, chatId)).unreadCount).toBe(0);
    });

    it("removes members, revoking their access immediately", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      const benSocket = await connect(ben);
      try {
        const removed = nextEvent<{ chatId: string }>(benSocket, "chat.removed");
        const response = await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ben.user.id}`);
        expect(response.statusCode).toBe(200);
        expect((await removed).chatId).toBe(chatId);
      } finally {
        benSocket.terminate();
      }

      expect((await api(ctx, ben, "GET", `/chats/${chatId}`)).statusCode).toBe(404);
      expect((await api(ctx, ben, "GET", `/chats/${chatId}/messages`)).statusCode).toBe(404);
      expect((await sendText(ctx, ben, chatId, "still here?")).statusCode).toBe(404);
      expect(await chatList(ben)).toEqual([]);

      const [, event] = await history(ana, chatId);
      expect(event?.system).toMatchObject({
        kind: "member.removed",
        actorId: ana.user.id,
        userId: ben.user.id,
      });
    });

    it("only lets admins remove people they outrank", async () => {
      const chatId = await createGroup(ana, [ben, cara, dev]);
      await promote(ana, chatId, ben);
      await promote(ana, chatId, cara);

      expect(
        (await api(ctx, dev, "DELETE", `/groups/${chatId}/members/${ben.user.id}`)).statusCode,
      ).toBe(403);
      expect(
        (await api(ctx, ben, "DELETE", `/groups/${chatId}/members/${cara.user.id}`)).statusCode,
      ).toBe(403);
      expect(
        (await api(ctx, ben, "DELETE", `/groups/${chatId}/members/${ana.user.id}`)).statusCode,
      ).toBe(403);
      expect(
        (await api(ctx, ben, "DELETE", `/groups/${chatId}/members/${dev.user.id}`)).statusCode,
      ).toBe(200);
      expect(
        (await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${cara.user.id}`)).statusCode,
      ).toBe(200);
      expect(
        (await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ana.user.id}`)).statusCode,
      ).toBe(400);
    });

    it("promotes and demotes admins with the owner in control", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await promote(ana, chatId, ben);
      await promote(ana, chatId, cara);

      const byAdmin = await api(ctx, ben, "PUT", `/groups/${chatId}/members/${cara.user.id}/role`, {
        role: "member",
      });
      expect(byAdmin.statusCode).toBe(403);
      const byOwner = await api(ctx, ana, "PUT", `/groups/${chatId}/members/${cara.user.id}/role`, {
        role: "member",
      });
      expect(byOwner.statusCode).toBe(200);
      const roles = byOwner
        .json<{ group: GroupBody }>()
        .group.members.map((member) => [member.displayName, member.role]);
      expect(roles).toEqual([
        ["Ana", "owner"],
        ["Ben", "admin"],
        ["Cara", "member"],
      ]);

      const ownerDemotion = await api(
        ctx,
        ben,
        "PUT",
        `/groups/${chatId}/members/${ana.user.id}/role`,
        {
          role: "member",
        },
      );
      expect(ownerDemotion.statusCode).toBe(403);
    });

    it("transfers ownership atomically", async () => {
      const chatId = await createGroup(ana, [ben]);
      expect(
        (await api(ctx, ben, "POST", `/groups/${chatId}/owner`, { userId: ben.user.id }))
          .statusCode,
      ).toBe(400);
      expect(
        (await api(ctx, ben, "POST", `/groups/${chatId}/owner`, { userId: ana.user.id }))
          .statusCode,
      ).toBe(403);

      const response = await api(ctx, ana, "POST", `/groups/${chatId}/owner`, {
        userId: ben.user.id,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ group: GroupBody }>().group.myRole).toBe("admin");
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM chat_members WHERE chat_id = $1 AND role = 'owner' AND left_at IS NULL",
        [chatId],
      );
      expect(rows).toEqual([{ user_id: ben.user.id }]);
      expect((await systemKinds(ana, chatId)).at(-1)).toBe("owner.changed");
    });

    it("hands ownership to the longest-standing admin, then member, when the owner leaves", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await promote(ana, chatId, cara);
      expect((await api(ctx, ana, "POST", `/groups/${chatId}/leave`)).statusCode).toBe(204);
      expect((await details(cara, chatId)).myRole).toBe("owner");
      expect((await systemKinds(ben, chatId)).slice(-2)).toEqual(["member.left", "owner.changed"]);

      expect((await api(ctx, cara, "POST", `/groups/${chatId}/leave`)).statusCode).toBe(204);
      expect((await details(ben, chatId)).myRole).toBe("owner");
      expect(await chatList(ana)).toEqual([]);
    });

    it("lets the owner choose a successor", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await promote(ana, chatId, ben);
      await api(ctx, ana, "POST", `/groups/${chatId}/leave`, { newOwnerId: cara.user.id });
      expect((await details(cara, chatId)).myRole).toBe("owner");
      expect((await details(ben, chatId)).myRole).toBe("admin");
    });

    it("deletes the group when its last member leaves", async () => {
      const chatId = await createGroup(ana, [ben]);
      await api(ctx, ben, "POST", `/groups/${chatId}/leave`);
      await api(ctx, ana, "POST", `/groups/${chatId}/leave`);
      const { rows } = await pool.query<{ deleted_at: Date | null }>(
        "SELECT deleted_at FROM groups WHERE chat_id = $1",
        [chatId],
      );
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it("only lets the owner delete the group, ending everyone's access", async () => {
      const chatId = await createGroup(ana, [ben]);
      await promote(ana, chatId, ben);
      expect((await api(ctx, ben, "DELETE", `/groups/${chatId}`)).statusCode).toBe(403);

      const benSocket = await connect(ben);
      try {
        const removed = nextEvent(benSocket, "chat.removed");
        expect((await api(ctx, ana, "DELETE", `/groups/${chatId}`)).statusCode).toBe(204);
        await removed;
      } finally {
        benSocket.terminate();
      }
      expect(await chatList(ana)).toEqual([]);
      expect((await api(ctx, ben, "GET", `/groups/${chatId}`)).statusCode).toBe(404);
    });

    it("lets a removed member be added back by an admin", async () => {
      const chatId = await createGroup(ana, [ben]);
      await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ben.user.id}`);
      const readd = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: [ben.user.id],
      });
      expect(readd.statusCode).toBe(200);
      expect((await summary(ben, chatId)).group?.myRole).toBe("member");
    });
  });

  describe("invite links", () => {
    it("requires links to be enabled and stores only the token hash", async () => {
      const chatId = await createGroup(ana, [ben]);
      const disabled = await api(ctx, ana, "POST", `/groups/${chatId}/invite`, {});
      expect(disabled.json<{ error: { code: string } }>().error.code).toBe("INVITES_DISABLED");

      await settings(ana, chatId, { inviteLinksEnabled: true });
      expect((await api(ctx, ben, "POST", `/groups/${chatId}/invite`, {})).statusCode).toBe(403);

      const token = await enableInvites(ana, chatId);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { rows } = await pool.query<{ token_hash: Buffer }>(
        "SELECT token_hash FROM group_invites WHERE chat_id = $1",
        [chatId],
      );
      expect(rows).toHaveLength(1);
      expect(
        Buffer.from(rows[0]?.token_hash ?? []).equals(createHash("sha256").update(token).digest()),
      ).toBe(true);
    });

    it("previews without the member list and joins once", async () => {
      const chatId = await createGroup(ana, [ben]);
      const token = await enableInvites(ana, chatId);

      const preview = await api(ctx, cara, "GET", `/invites/${token}`);
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual({
        invite: {
          name: "Weekend plans",
          description: null,
          memberCount: 2,
          approvalRequired: false,
          alreadyMember: false,
          chatId: null,
        },
      });

      const join = await api(ctx, cara, "POST", `/invites/${token}/join`);
      expect(join.json()).toEqual({ status: "joined", chatId });
      expect((await api(ctx, cara, "POST", `/invites/${token}/join`)).json()).toEqual({
        status: "joined",
        chatId,
      });
      expect((await details(ana, chatId)).invite?.useCount).toBe(1);
      expect((await systemKinds(ana, chatId)).at(-1)).toBe("member.joined");
    });

    it("rejects unknown, revoked, expired and used-up links", async () => {
      const chatId = await createGroup(ana, [ben]);
      const bogus = "A".repeat(43);
      expect((await api(ctx, cara, "GET", `/invites/${bogus}`)).statusCode).toBe(404);

      const revoked = await enableInvites(ana, chatId);
      expect((await api(ctx, ana, "DELETE", `/groups/${chatId}/invite`)).statusCode).toBe(204);
      const afterRevoke = await api(ctx, cara, "POST", `/invites/${revoked}/join`);
      expect(afterRevoke.json<{ error: { code: string } }>().error.code).toBe("INVITE_INVALID");

      const limited = await api(ctx, ana, "POST", `/groups/${chatId}/invite`, { maxUses: 1 });
      const limitedToken = limited.json<{ token: string }>().token;
      expect((await api(ctx, cara, "POST", `/invites/${limitedToken}/join`)).statusCode).toBe(200);
      expect((await api(ctx, dev, "POST", `/invites/${limitedToken}/join`)).statusCode).toBe(404);

      const expiring = await api(ctx, ana, "POST", `/groups/${chatId}/invite`, {});
      const expiringToken = expiring.json<{ token: string }>().token;
      await pool.query(
        "UPDATE group_invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE revoked_at IS NULL",
      );
      expect((await api(ctx, dev, "POST", `/invites/${expiringToken}/join`)).statusCode).toBe(404);

      const replaced = await api(ctx, ana, "POST", `/groups/${chatId}/invite`, {});
      const replacedToken = replaced.json<{ token: string }>().token;
      await settings(ana, chatId, { inviteLinksEnabled: false });
      expect((await api(ctx, dev, "POST", `/invites/${replacedToken}/join`)).statusCode).toBe(404);
    });

    it("does not let removed members rejoin through a link", async () => {
      const chatId = await createGroup(ana, [ben]);
      const token = await enableInvites(ana, chatId);
      await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ben.user.id}`);
      const response = await api(ctx, ben, "POST", `/invites/${token}/join`);
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("GROUP_JOIN_FORBIDDEN");
    });

    it("lets people who left rejoin", async () => {
      const chatId = await createGroup(ana, [ben]);
      const token = await enableInvites(ana, chatId);
      await api(ctx, ben, "POST", `/groups/${chatId}/leave`);
      expect((await api(ctx, ben, "POST", `/invites/${token}/join`)).json()).toEqual({
        status: "joined",
        chatId,
      });
    });

    it("files join requests when approval is required", async () => {
      const chatId = await createGroup(ana, [ben]);
      const token = await enableInvites(ana, chatId, { approvalRequired: true });

      expect((await api(ctx, cara, "POST", `/invites/${token}/join`)).json()).toEqual({
        status: "pending",
      });
      expect((await api(ctx, cara, "POST", `/invites/${token}/join`)).json()).toEqual({
        status: "pending",
      });
      expect((await api(ctx, dev, "POST", `/invites/${token}/join`)).json()).toEqual({
        status: "pending",
      });
      expect((await api(ctx, cara, "GET", `/groups/${chatId}`)).statusCode).toBe(404);

      const pending = (await details(ana, chatId)).pendingRequests?.map(
        (request) => request.userId,
      );
      expect(pending).toEqual([cara.user.id, dev.user.id]);
      expect(
        (await api(ctx, ben, "POST", `/groups/${chatId}/requests/${cara.user.id}/approve`))
          .statusCode,
      ).toBe(403);

      const approved = await api(
        ctx,
        ana,
        "POST",
        `/groups/${chatId}/requests/${cara.user.id}/approve`,
      );
      expect(approved.statusCode).toBe(200);
      expect((await summary(cara, chatId)).group?.myRole).toBe("member");
      const joined = (await history(ana, chatId)).at(-1);
      expect(joined?.system).toMatchObject({
        kind: "member.joined",
        actorId: cara.user.id,
        approvedBy: ana.user.id,
      });

      const rejected = await api(
        ctx,
        ana,
        "POST",
        `/groups/${chatId}/requests/${dev.user.id}/reject`,
      );
      expect(rejected.json<{ group: GroupBody }>().group.pendingRequests).toEqual([]);
      expect(
        (await api(ctx, ana, "POST", `/groups/${chatId}/requests/${dev.user.id}/approve`))
          .statusCode,
      ).toBe(404);
      expect((await api(ctx, dev, "GET", `/chats/${chatId}`)).statusCode).toBe(404);
    });
  });

  describe("messaging", () => {
    it("fans messages out to active members only", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${cara.user.id}`);
      const benSocket = await connect(ben);
      const caraSocket = await connect(cara);
      try {
        const toBen = nextEvent<{ message: MessageBody }>(benSocket, "message.new");
        const toCara = nextEvent(caraSocket, "message.new", 300);
        expect((await sendText(ctx, ana, chatId, "members only")).statusCode).toBe(201);
        expect((await toBen).message.senderId).toBe(ana.user.id);
        await expect(toCara).rejects.toThrow(/timed out/);
      } finally {
        benSocket.terminate();
        caraSocket.terminate();
      }
    });

    it("refuses client-generated system messages", async () => {
      const chatId = await createGroup(ana, [ben]);
      const response = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "system",
        ciphertext: encodeText("fake event"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("validates mentions against current membership", async () => {
      const chatId = await createGroup(ana, [ben]);
      const ok = await sendWith(ana, chatId, `hi @{${ben.user.id}}`, { mentions: [ben.user.id] });
      expect(ok.statusCode).toBe(201);
      expect(ok.json<{ message: MessageBody }>().message.mentions).toEqual([ben.user.id]);
      expect((await history(ben, chatId)).at(-1)?.mentions).toEqual([ben.user.id]);

      const outsider = await sendWith(ana, chatId, "hey", { mentions: [cara.user.id] });
      expect(outsider.statusCode).toBe(400);
      expect(outsider.json<{ error: { code: string } }>().error.code).toBe("INVALID_MENTIONS");

      const directId = await openChat(ctx, ana, cara);
      const direct = await sendWith(ana, directId, "hey", { mentions: [cara.user.id] });
      expect(direct.json<{ error: { code: string } }>().error.code).toBe("MENTIONS_NOT_ALLOWED");
    });

    it("quotes replies only when the target is visible", async () => {
      const chatId = await createGroup(ana, [ben]);
      const original = (await sendText(ctx, ana, chatId, "original")).json<{
        message: MessageBody;
      }>().message;
      const reply = await sendWith(ben, chatId, "reply", { replyToMessageId: original.id });
      expect(reply.statusCode).toBe(201);
      expect(reply.json<{ message: MessageBody }>().message.replyTo).toEqual({
        id: original.id,
        available: true,
        senderId: ana.user.id,
        type: "text",
        ciphertext: encodeText("original"),
      });

      await api(ctx, ana, "POST", `/groups/${chatId}/members`, { userIds: [cara.user.id] });
      // Cara joined after the original, so she may not quote it…
      const hidden = await sendWith(cara, chatId, "?", { replyToMessageId: original.id });
      expect(hidden.json<{ error: { code: string } }>().error.code).toBe("REPLY_UNAVAILABLE");

      // …and a later reply to it shows her an unavailable quote.
      const caraSocket = await connect(cara);
      try {
        const live = nextEvent<{ message: MessageBody }>(caraSocket, "message.new");
        await sendWith(ben, chatId, "again", { replyToMessageId: original.id });
        expect((await live).message.replyTo).toEqual({
          id: original.id,
          available: false,
          senderId: null,
          type: null,
          ciphertext: null,
        });
      } finally {
        caraSocket.terminate();
      }

      const systemId = (await history(ana, chatId))[0]?.id;
      const toSystem = await sendWith(ana, chatId, "x", { replyToMessageId: systemId });
      expect(toSystem.statusCode).toBe(400);
    });

    it("keeps one reaction per person and broadcasts changes", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      const message = (await sendText(ctx, ana, chatId, "react to me")).json<{
        message: MessageBody;
      }>().message;
      const url = `/chats/${chatId}/messages/${message.id}/reaction`;

      const anaSocket = await connect(ana);
      try {
        const event = nextEvent<{ userId: string; emoji: string | null }>(
          anaSocket,
          "reaction.updated",
        );
        expect((await api(ctx, ben, "PUT", url, { emoji: "👍" })).statusCode).toBe(200);
        expect(await event).toMatchObject({ userId: ben.user.id, emoji: "👍" });
      } finally {
        anaSocket.terminate();
      }

      const changed = await api(ctx, ben, "PUT", url, { emoji: "❤️" });
      expect(changed.json<{ reactions: unknown[] }>().reactions).toEqual([
        { userId: ben.user.id, emoji: "❤️" },
      ]);
      await api(ctx, cara, "PUT", url, { emoji: "😂" });
      expect((await history(ana, chatId)).at(-1)?.reactions).toHaveLength(2);

      expect((await api(ctx, ben, "PUT", url, { emoji: "🦄" })).statusCode).toBe(400);
      const removed = await api(ctx, ben, "DELETE", url);
      expect(removed.json<{ reactions: unknown[] }>().reactions).toEqual([
        { userId: cara.user.id, emoji: "😂" },
      ]);
      expect((await api(ctx, dev, "PUT", url, { emoji: "👍" })).statusCode).toBe(404);
    });

    it("moderates deletion by sender and rank, leaving tombstones", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await promote(ana, chatId, ben);
      const fromCara = (await sendText(ctx, cara, chatId, "cara's")).json<{
        message: MessageBody;
      }>().message;
      const fromAna = (await sendText(ctx, ana, chatId, "ana's")).json<{ message: MessageBody }>()
        .message;
      const fromBen = (await sendText(ctx, ben, chatId, "ben's")).json<{ message: MessageBody }>()
        .message;
      await api(ctx, ana, "PUT", `/chats/${chatId}/messages/${fromCara.id}/reaction`, {
        emoji: "👍",
      });

      expect(
        (await api(ctx, cara, "DELETE", `/chats/${chatId}/messages/${fromBen.id}`)).statusCode,
      ).toBe(403);
      expect(
        (await api(ctx, ben, "DELETE", `/chats/${chatId}/messages/${fromAna.id}`)).statusCode,
      ).toBe(403);

      const caraSocket = await connect(cara);
      try {
        const deletedEvent = nextEvent<{ message: MessageBody }>(caraSocket, "message.deleted");
        const byAdmin = await api(ctx, ben, "DELETE", `/chats/${chatId}/messages/${fromCara.id}`);
        expect(byAdmin.statusCode).toBe(200);
        expect((await deletedEvent).message).toMatchObject({
          id: fromCara.id,
          deleted: true,
          ciphertext: "",
        });
      } finally {
        caraSocket.terminate();
      }
      expect(
        (await api(ctx, ben, "DELETE", `/chats/${chatId}/messages/${fromBen.id}`)).statusCode,
      ).toBe(200);
      expect(
        (await api(ctx, ben, "DELETE", `/chats/${chatId}/messages/${fromBen.id}`)).statusCode,
      ).toBe(200);

      const tombstone = (await history(ana, chatId)).find((message) => message.id === fromCara.id);
      expect(tombstone).toMatchObject({
        deleted: true,
        deletedBy: ben.user.id,
        ciphertext: "",
        reactions: [],
      });
      const { rows } = await pool.query<{ n: number }>(
        "SELECT octet_length(ciphertext) AS n FROM messages WHERE id = $1",
        [fromCara.id],
      );
      expect(rows[0]?.n).toBe(0);

      const systemId = (await history(ana, chatId))[0]?.id;
      expect(
        (await api(ctx, ana, "DELETE", `/chats/${chatId}/messages/${systemId}`)).statusCode,
      ).toBe(404);
      expect((await sendWith(ana, chatId, "x", { replyToMessageId: fromCara.id })).statusCode).toBe(
        400,
      );
    });

    it("lets admins delete messages from former members", async () => {
      const chatId = await createGroup(ana, [ben]);
      const fromBen = (await sendText(ctx, ben, chatId, "bye")).json<{ message: MessageBody }>()
        .message;
      await api(ctx, ben, "POST", `/groups/${chatId}/leave`);
      expect(
        (await api(ctx, ana, "DELETE", `/chats/${chatId}/messages/${fromBen.id}`)).statusCode,
      ).toBe(200);
    });

    it("counts unread messages but not system events, and aggregates receipts", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      await sendText(ctx, ana, chatId, "one");
      await settings(ana, chatId, { approvalRequired: true });
      await sendText(ctx, ana, chatId, "two");

      const benSummary = await summary(ben, chatId);
      expect(benSummary.unreadCount).toBe(2);
      expect(benSummary.lastMessage?.type).toBe("text");
      expect((await summary(ana, chatId)).peerReadSequence).toBe(0);

      const anaSocket = await connect(ana);
      try {
        const lastSequence = benSummary.lastSequence;
        await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { readSequence: lastSequence });
        expect((await summary(ana, chatId)).peerReadSequence).toBe(0);

        const aggregate = nextEvent<{ readSequence: number }>(anaSocket, "receipts.aggregate");
        await api(ctx, cara, "POST", `/chats/${chatId}/receipts`, { readSequence: lastSequence });
        expect((await aggregate).readSequence).toBe(lastSequence);
        expect((await summary(ana, chatId)).peerReadSequence).toBe(lastSequence);
      } finally {
        anaSocket.terminate();
      }
    });

    it("mutes groups", async () => {
      const chatId = await createGroup(ana, [ben]);
      const response = await api(ctx, ben, "PUT", `/chats/${chatId}/mute`, { muted: true });
      expect(response.json<{ chat: { muted: boolean } }>().chat.muted).toBe(true);
    });
  });

  describe("reports", () => {
    it("reports a group or one of its messages", async () => {
      const chatId = await createGroup(ana, [ben]);
      const message = (await sendText(ctx, ana, chatId, "spam")).json<{ message: MessageBody }>()
        .message;

      const group = await api(ctx, ben, "POST", "/privacy/reports", { chatId, reason: "spam" });
      expect(group.statusCode).toBe(201);
      const byMessage = await api(ctx, ben, "POST", "/privacy/reports", {
        chatId,
        messageId: message.id,
        reason: "spam",
        block: true,
      });
      expect(byMessage.statusCode).toBe(201);

      const { rows } = await pool.query<{
        reported_user_id: string | null;
        message_id: string | null;
      }>(
        "SELECT reported_user_id, message_id FROM user_reports WHERE reporter_id = $1 ORDER BY created_at",
        [ben.user.id],
      );
      expect(rows).toEqual([
        { reported_user_id: null, message_id: null },
        { reported_user_id: ana.user.id, message_id: message.id },
      ]);

      const own = await api(ctx, ana, "POST", "/privacy/reports", {
        chatId,
        messageId: message.id,
        reason: "spam",
      });
      expect(own.statusCode).toBe(400);
      expect(
        (await api(ctx, cara, "POST", "/privacy/reports", { chatId, reason: "spam" })).statusCode,
      ).toBe(404);
    });
  });
});
