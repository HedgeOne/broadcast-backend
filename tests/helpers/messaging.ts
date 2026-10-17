import { randomUUID } from "node:crypto";

import type { LightMyRequestResponse } from "fastify";
import type { WebSocket } from "ws";

import { pool } from "../../src/db/client.js";
import { bearer, login, testPhone, type LoginResult, type TestContext } from "./auth.js";

export interface TestUser extends LoginResult {
  phone: string;
}

// Signs a user in through the phone OTP flow, then names them.
export async function createUser(
  ctx: TestContext,
  name: string,
  options: { displayName?: string; phone?: string } = {},
): Promise<TestUser> {
  const phone = options.phone ?? testPhone();
  const session = await login(ctx, phone);
  await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [
    session.user.id,
    options.displayName ?? name,
  ]);
  return { ...session, phone };
}

/** Opaque OpenE2EE protocol pointer. Never encodes message plaintext. */
export function encodeText(_text = ""): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      protocol: "opene2ee-v1",
      relayMessageId: `test-relay-${randomUUID()}`,
      clientMessageId: randomUUID(),
      chatId: randomUUID(),
    }),
    "utf8",
  ).toString("base64");
}

export function api(
  ctx: TestContext,
  user: TestUser,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method,
    url,
    headers: bearer(user.accessToken),
    ...(payload ? { payload } : {}),
  });
}

export async function openChat(ctx: TestContext, user: TestUser, other: TestUser): Promise<string> {
  const response = await api(ctx, user, "POST", "/chats/direct", { userId: other.user.id });
  if (response.statusCode !== 200) throw new Error(`open chat failed: ${response.body}`);
  return response.json<{ chat: { id: string } }>().chat.id;
}

export function sendText(
  ctx: TestContext,
  user: TestUser,
  chatId: string,
  text: string,
  clientMessageId: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return api(ctx, user, "POST", `/chats/${chatId}/messages`, {
    clientMessageId,
    type: "text",
    ciphertext: encodeText(text),
    protocol: "opene2ee-v1",
  });
}

// Resolves with the next event of the given type received on the socket.
export function nextEvent<T = Record<string, unknown>>(
  socket: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    function onMessage(raw: Buffer) {
      const event = JSON.parse(raw.toString("utf8")) as { type?: unknown };
      if (event.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(event as T);
    }
    socket.on("message", onMessage);
  });
}
