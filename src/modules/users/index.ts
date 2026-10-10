import type { FastifyPluginAsync } from "fastify";

import { db } from "../../db/client.js";
import { UsersRepository } from "./users.repository.js";
import { usersRoutes } from "./users.routes.js";

// Must be registered after the auth module, which provides `app.authenticate`.
export const usersModule: FastifyPluginAsync = async (app) => {
  await app.register(usersRoutes, {
    prefix: "/users",
    repository: new UsersRepository(db),
  });
};
