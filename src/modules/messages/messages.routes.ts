import type { FastifyPluginCallback } from "fastify";

import { chatParams } from "../chats/chats.schemas.js";
import {
  listMessagesQuery,
  messageParams,
  reactionBody,
  sendMessageBody,
} from "./messages.schemas.js";
import type { MessagesService } from "./messages.service.js";

export interface MessagesRoutesOptions {
  service: MessagesService;
}

export const messagesRoutes: FastifyPluginCallback<MessagesRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/:chatId/messages", async (request) => {
    const { chatId } = chatParams.parse(request.params);
    const query = listMessagesQuery.parse(request.query);
    return service.list(request.auth.userId, chatId, query);
  });

  // 201 for a newly stored message, 200 when a retry matched a stored one.
  app.post("/:chatId/messages", async (request, reply) => {
    const { chatId } = chatParams.parse(request.params);
    const body = sendMessageBody.parse(request.body);
    const result = await service.send(request.auth, chatId, body);
    return reply.code(result.created ? 201 : 200).send({ message: result.message });
  });

  // Idempotent: deleting a deleted message returns the tombstone.
  app.delete("/:chatId/messages/:messageId", async (request) => {
    const { chatId, messageId } = messageParams.parse(request.params);
    return { message: await service.delete(request.auth.userId, chatId, messageId) };
  });

  app.put("/:chatId/messages/:messageId/reaction", async (request) => {
    const { chatId, messageId } = messageParams.parse(request.params);
    const { emoji } = reactionBody.parse(request.body);
    return service.react(request.auth.userId, chatId, messageId, emoji);
  });

  app.delete("/:chatId/messages/:messageId/reaction", async (request) => {
    const { chatId, messageId } = messageParams.parse(request.params);
    return service.react(request.auth.userId, chatId, messageId, null);
  });

  done();
};
