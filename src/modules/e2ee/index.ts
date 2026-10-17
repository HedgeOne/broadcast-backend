import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

import { e2eeRoutes } from "./e2ee.routes.js";
import { E2eeService } from "./e2ee.service.js";

export const e2eeModule: FastifyPluginAsync = fp(async (app) => {
  const e2ee = new E2eeService();
  await app.register(e2eeRoutes, { e2ee });
});
