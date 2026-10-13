import type { FastifyPluginCallback } from "fastify";

import { photoRef } from "../media/media.schemas.js";
import {
  addRecipientsBody,
  broadcastParams,
  clearListBody,
  createListBody,
  historyQuery,
  listParams,
  recipientParams,
  sendBroadcastBody,
  sharedQuery,
  starredQuery,
  updateListBody,
} from "./broadcasts.schemas.js";
import type { BroadcastsService } from "./broadcasts.service.js";

export interface BroadcastsRoutesOptions {
  service: BroadcastsService;
}

// Every route is scoped to the authenticated owner inside the service;
// nothing here trusts client-supplied owner, sender or status values.
export const broadcastsRoutes: FastifyPluginCallback<BroadcastsRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    return { lists: await service.list(request.auth.userId) };
  });

  // 201 when created, 200 when a retry matched the original request.
  app.post("/", async (request, reply) => {
    const body = createListBody.parse(request.body);
    const result = await service.create(request.auth.userId, body);
    return reply.code(result.created ? 201 : 200).send({ list: result.list });
  });

  app.get("/:listId", async (request) => {
    const { listId } = listParams.parse(request.params);
    return { list: await service.details(request.auth.userId, listId) };
  });

  app.patch("/:listId", async (request) => {
    const { listId } = listParams.parse(request.params);
    const body = updateListBody.parse(request.body);
    return { list: await service.update(request.auth.userId, listId, body) };
  });

  app.delete("/:listId", async (request, reply) => {
    const { listId } = listParams.parse(request.params);
    await service.delete(request.auth.userId, listId);
    return reply.code(204).send();
  });

  app.put("/:listId/photo", async (request) => {
    const { listId } = listParams.parse(request.params);
    const photo = photoRef.parse(request.body);
    return { list: await service.setPhoto(request.auth.userId, listId, photo) };
  });

  app.delete("/:listId/photo", async (request) => {
    const { listId } = listParams.parse(request.params);
    return { list: await service.removePhoto(request.auth.userId, listId) };
  });

  app.post("/:listId/recipients", async (request) => {
    const { listId } = listParams.parse(request.params);
    const { recipientIds } = addRecipientsBody.parse(request.body);
    return { list: await service.addRecipients(request.auth.userId, listId, recipientIds) };
  });

  app.delete("/:listId/recipients/:userId", async (request) => {
    const { listId, userId } = recipientParams.parse(request.params);
    return { list: await service.removeRecipient(request.auth.userId, listId, userId) };
  });

  app.get("/:listId/messages", async (request) => {
    const { listId } = listParams.parse(request.params);
    const query = historyQuery.parse(request.query);
    return service.history(request.auth.userId, listId, query);
  });

  // 201 for a new broadcast, 200 when a retry matched an accepted one.
  app.post("/:listId/messages", async (request, reply) => {
    const { listId } = listParams.parse(request.params);
    const body = sendBroadcastBody.parse(request.body);
    const result = await service.send(request.auth, listId, body);
    return reply.code(result.created ? 201 : 200).send({ broadcast: result.broadcast });
  });

  app.get("/:listId/messages/:broadcastId", async (request) => {
    const { listId, broadcastId } = broadcastParams.parse(request.params);
    return service.report(request.auth.userId, listId, broadcastId);
  });

  app.post("/:listId/messages/:broadcastId/retry", async (request) => {
    const { listId, broadcastId } = broadcastParams.parse(request.params);
    return { broadcast: await service.retry(request.auth.userId, listId, broadcastId) };
  });

  app.put("/:listId/messages/:broadcastId/star", async (request) => {
    const { listId, broadcastId } = broadcastParams.parse(request.params);
    return { broadcast: await service.star(request.auth.userId, listId, broadcastId, true) };
  });

  app.delete("/:listId/messages/:broadcastId/star", async (request) => {
    const { listId, broadcastId } = broadcastParams.parse(request.params);
    return { broadcast: await service.star(request.auth.userId, listId, broadcastId, false) };
  });

  app.get("/:listId/starred", async (request) => {
    const { listId } = listParams.parse(request.params);
    const query = starredQuery.parse(request.query);
    return service.starred(request.auth.userId, listId, query);
  });

  app.get("/:listId/shared", async (request) => {
    const { listId } = listParams.parse(request.params);
    const query = sharedQuery.parse(request.query);
    return service.shared(request.auth.userId, listId, query);
  });

  // Clears the owner's view of the list only; recipients are unaffected.
  app.post("/:listId/clear", async (request) => {
    const { listId } = listParams.parse(request.params);
    const { keepStarred } = clearListBody.parse(request.body);
    return service.clear(request.auth.userId, listId, keepStarred);
  });

  done();
};
