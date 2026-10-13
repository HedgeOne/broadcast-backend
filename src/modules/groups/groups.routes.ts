import type { FastifyPluginCallback } from "fastify";

import { photoRef } from "../media/media.schemas.js";
import {
  addMembersBody,
  createGroupBody,
  createInviteBody,
  groupParams,
  inviteParams,
  leaveBody,
  memberParams,
  roleBody,
  transferOwnerBody,
  updateGroupBody,
  updateSettingsBody,
} from "./groups.schemas.js";
import type { GroupsService } from "./groups.service.js";

export interface GroupsRoutesOptions {
  service: GroupsService;
}

// Every route authorizes inside GroupsService against membership state
// read under the chat lock; nothing here trusts client-supplied roles.
export const groupsRoutes: FastifyPluginCallback<GroupsRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  // 201 when created, 200 when a retry matched the original request.
  app.post("/", async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    const result = await service.create(request.auth.userId, body);
    return reply.code(result.created ? 201 : 200).send({ chat: result.chat });
  });

  app.get("/:chatId", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    return { group: await service.details(request.auth.userId, chatId) };
  });

  app.patch("/:chatId", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    const body = updateGroupBody.parse(request.body);
    return { group: await service.updateInfo(request.auth.userId, chatId, body) };
  });

  app.put("/:chatId/photo", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    const photo = photoRef.parse(request.body);
    return { group: await service.setPhoto(request.auth.userId, chatId, photo) };
  });

  app.delete("/:chatId/photo", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    return { group: await service.removePhoto(request.auth.userId, chatId) };
  });

  app.patch("/:chatId/settings", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    const body = updateSettingsBody.parse(request.body);
    return { group: await service.updateSettings(request.auth.userId, chatId, body) };
  });

  app.delete("/:chatId", async (request, reply) => {
    const { chatId } = groupParams.parse(request.params);
    await service.deleteGroup(request.auth.userId, chatId);
    return reply.code(204).send();
  });

  app.post("/:chatId/members", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    const { userIds } = addMembersBody.parse(request.body);
    return { group: await service.addMembers(request.auth.userId, chatId, userIds) };
  });

  app.delete("/:chatId/members/:userId", async (request) => {
    const { chatId, userId } = memberParams.parse(request.params);
    return { group: await service.removeMember(request.auth.userId, chatId, userId) };
  });

  app.put("/:chatId/members/:userId/role", async (request) => {
    const { chatId, userId } = memberParams.parse(request.params);
    const { role } = roleBody.parse(request.body);
    return { group: await service.setRole(request.auth.userId, chatId, userId, role) };
  });

  app.post("/:chatId/owner", async (request) => {
    const { chatId } = groupParams.parse(request.params);
    const { userId } = transferOwnerBody.parse(request.body);
    return { group: await service.transferOwnership(request.auth.userId, chatId, userId) };
  });

  app.post("/:chatId/leave", async (request, reply) => {
    const { chatId } = groupParams.parse(request.params);
    const body = leaveBody.parse(request.body ?? {});
    await service.leave(request.auth.userId, chatId, body.newOwnerId);
    return reply.code(204).send();
  });

  app.post("/:chatId/invite", async (request, reply) => {
    const { chatId } = groupParams.parse(request.params);
    const body = createInviteBody.parse(request.body ?? {});
    return reply.code(201).send(await service.createInvite(request.auth.userId, chatId, body));
  });

  app.delete("/:chatId/invite", async (request, reply) => {
    const { chatId } = groupParams.parse(request.params);
    await service.revokeInvite(request.auth.userId, chatId);
    return reply.code(204).send();
  });

  app.post("/:chatId/requests/:userId/approve", async (request) => {
    const { chatId, userId } = memberParams.parse(request.params);
    return { group: await service.approveRequest(request.auth.userId, chatId, userId) };
  });

  app.post("/:chatId/requests/:userId/reject", async (request) => {
    const { chatId, userId } = memberParams.parse(request.params);
    return { group: await service.rejectRequest(request.auth.userId, chatId, userId) };
  });

  done();
};

export const invitesRoutes: FastifyPluginCallback<GroupsRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/:token", async (request) => {
    const { token } = inviteParams.parse(request.params);
    return { invite: await service.previewInvite(request.auth.userId, token) };
  });

  app.post("/:token/join", async (request) => {
    const { token } = inviteParams.parse(request.params);
    return service.joinByInvite(request.auth.userId, token);
  });

  done();
};
