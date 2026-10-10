import type { FastifyPluginCallback } from "fastify";

import { phoneResendBody, phoneStartBody, phoneVerifyBody, refreshBody } from "./auth.schemas.js";
import type { AuthService } from "./auth.service.js";

export interface AuthRoutesOptions {
  service: AuthService;
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, { service }, done) => {
  // The backend sends the OTP through MSG91 and keeps the provider's request
  // id; the client only receives an opaque challenge id.
  app.post("/phone/start", async (request) => {
    const body = phoneStartBody.parse(request.body);
    return service.startPhoneSignIn(body.phoneNumber, request.ip);
  });

  app.post("/phone/resend", async (request) => {
    const body = phoneResendBody.parse(request.body);
    return service.resendPhoneCode(body.challengeId, request.ip);
  });

  app.post("/phone/verify", async (request) => {
    const body = phoneVerifyBody.parse(request.body);
    const result = await service.verifyPhoneCode(
      body.challengeId,
      body.code,
      body.device,
      request.ip,
    );

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
