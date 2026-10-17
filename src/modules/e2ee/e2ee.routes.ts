import type { FastifyPluginAsync } from "fastify";

import { identityAssertionBody } from "./e2ee.schemas.js";
import type { E2eeService } from "./e2ee.service.js";

export const e2eeRoutes: FastifyPluginAsync<{ e2ee: E2eeService }> = (app, opts) => {
  app.post("/e2ee/identity-assertion", { preHandler: app.authenticate }, async (request) => {
    const body = identityAssertionBody.parse(request.body);
    return opts.e2ee.mintAssertion(request.auth, body);
  });
  return Promise.resolve();
};
