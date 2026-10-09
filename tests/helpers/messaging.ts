import { createHash, randomUUID } from "node:crypto";

import type { LightMyRequestResponse } from "fastify";
import type { WebSocket } from "ws";

import { pool } from "../../src/db/client.js";
import { bearer, login, type LoginResult, type TestContext } from "./auth.js";

export interface TestUser extends LoginResult {
  phone?: string;
}

export async function createUser(
  ctx: TestContext,
  email: string,
  options: { displayName?: string; phone?: string; phoneVerified?: boolean } = {},
): Promise<TestUser> {
  const session = await login(ctx, email);
  await pool.query(
    `UPDATE users SET display_name = $2, phone_number = $3,
       phone_number_verified_at = CASE WHEN $4::boolean THEN NOW() END
     WHERE id = $1`,
    [
      session.user.id,
      options.displayName ?? email.split("@")[0],
      options.phone ?? null,
      options.phoneVerified ?? options.phone !== undefined,
    ],
  );
  return { ...session, ...(options.phone ? { phone: options.phone } : {}) };
}

export function phoneHash(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

export function encodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function api(
  ctx: TestContext,
  user: TestUser,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
