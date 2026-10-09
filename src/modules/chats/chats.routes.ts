import type { FastifyPluginCallback } from "fastify";

import { chatParams, createDirectChatBody, muteBody, receiptsBody } from "./chats.schemas.js";
import type { ChatsService } from "./chats.service.js";

export interface ChatsRoutesOptions {
  service: ChatsService;
}

export const chatsRoutes: FastifyPluginCallback<ChatsRoutesOptions> = (app, { service }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    return { chats: await service.list(request.auth.userId) };
  });

  app.post("/direct", async (request) => {
    const body = createDirectChatBody.parse(request.body);
    return { chat: await service.openDirect(request.auth.userId, body.userId) };
  });

  app.get("/:chatId", async (request) => {
    const { chatId } = chatParams.parse(request.params);
    return { chat: await service.get(request.auth.userId, chatId) };
  });

  app.put("/:chatId/mute", async (request) => {
    const { chatId } = chatParams.parse(request.params);
    const body = muteBody.parse(request.body);
    return { chat: await service.setMuted(request.auth.userId, chatId, body.muted) };
  });

  app.post("/:chatId/receipts", async (request) => {
    const { chatId } = chatParams.parse(request.params);
    const body = receiptsBody.parse(request.body);
    return service.advanceReceipts(request.auth.userId, chatId, body);
  });

  done();
};
