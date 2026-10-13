import type { FastifyPluginCallback } from "fastify";

import { AppError } from "../../lib/errors.js";
import { authErrors } from "../auth/auth.errors.js";
import { toPublicUser } from "../auth/auth.types.js";
import { chatErrors } from "../chats/chats.errors.js";
import type { UsersRepository } from "./users.repository.js";
import { updateMeBody, userParams } from "./users.schemas.js";

export interface UsersRoutesOptions {
  repository: UsersRepository;
}

export const usersRoutes: FastifyPluginCallback<UsersRoutesOptions> = (
  app,
  { repository },
  done,
) => {
  const bodySchema = updateMeBody();

  app.patch("/me", { preHandler: app.authenticate }, async (request) => {
    const body = bodySchema.parse(request.body);
    const user = await repository.updateProfile(request.auth.userId, body);
    if (!user) {
      throw authErrors.unauthenticated();
    }
    return { user: toPublicUser(user) };
  });

  app.get("/:userId", { preHandler: app.authenticate }, async (request) => {
    const { userId } = userParams.parse(request.params);
    const user = await repository.findProfile(request.auth.userId, userId);
    if (!user) throw chatErrors.userNotFound();
    return { user };
  });

  // For another person's contact page: groups the caller shares with them.
  app.get("/:userId/groups-in-common", { preHandler: app.authenticate }, async (request) => {
    const { userId } = userParams.parse(request.params);
    if (userId === request.auth.userId) {
      throw new AppError(400, "INVALID_USER", "Choose someone other than yourself.");
    }
    if (!(await repository.findProfile(request.auth.userId, userId))) {
      throw chatErrors.userNotFound();
    }
    return { groups: await repository.groupsInCommon(request.auth.userId, userId) };
  });

  done();
};
