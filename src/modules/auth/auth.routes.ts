import type { FastifyPluginCallback } from "fastify";

import { emailVerifyBody, refreshBody } from "./auth.schemas.js";
import type { AuthService } from "./auth.service.js";

export interface AuthRoutesOptions {
  service: AuthService;
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, { service }, done) => {
  // The client has already verified the OTP with the MSG91 widget and sends
  // the widget's access token; MSG91 is asked server-side which email it proves.
  app.post("/email/verify", async (request) => {
    const body = emailVerifyBody.parse(request.body);
    const result = await service.verifyEmail(body.accessToken, body.device, request.ip);

    return {
      ...result.tokens,
      user: result.user,
      device: result.device,
      isNewUser: result.isNewUser,
    };
  });

  app.post("/refresh", async (request) => {
    const body = refreshBody.parse(request.body);
    return service.refresh(body.refreshToken);
  });

  app.post("/logout", { preHandler: app.authenticate }, async (request, reply) => {
    await service.logout(request.auth);
    return reply.code(204).send();
  });

  app.post("/logout-all", { preHandler: app.authenticate }, async (request, reply) => {
    await service.logoutAll(request.auth);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    return service.me(request.auth);
  });

  done();
};
