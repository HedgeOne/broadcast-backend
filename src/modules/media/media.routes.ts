import type { FastifyPluginCallback } from "fastify";

import { attachmentParams, createUploadBody, uploadParams, urlQuery } from "./media.schemas.js";
import type { MediaService } from "./media.service.js";

export interface MediaRoutesOptions {
  service: MediaService;
}

// Upload sessions belong to the authenticated user; attachment downloads
// are authorized through the message. Responses never contain storage
// keys or credentials, and signed URLs are never logged.
export const mediaRoutes: FastifyPluginCallback<MediaRoutesOptions> = (app, { service }, done) => {
  app.addHook("preHandler", app.authenticate);

  // 201 for a new session, 200 when a retry matched an existing one.
  // `target` is null once the object is already verified.
  app.post("/uploads", async (request, reply) => {
    const body = createUploadBody.parse(request.body);
    const result = await service.createUpload(request.auth.userId, body);
    return reply
      .code(result.created ? 201 : 200)
      .header("cache-control", "no-store")
      .send({ upload: result.upload, target: result.target });
  });

  app.get("/uploads/:uploadId", async (request) => {
    const { uploadId } = uploadParams.parse(request.params);
    return { upload: await service.getUpload(request.auth.userId, uploadId) };
  });

  app.post("/uploads/:uploadId/complete", async (request) => {
    const { uploadId } = uploadParams.parse(request.params);
    return { upload: await service.completeUpload(request.auth.userId, uploadId) };
  });

  app.delete("/uploads/:uploadId", async (request, reply) => {
    const { uploadId } = uploadParams.parse(request.params);
    await service.discardUpload(request.auth.userId, uploadId);
    return reply.code(204).send();
  });

  app.get("/uploads/:uploadId/url", async (request, reply) => {
    const { uploadId } = uploadParams.parse(request.params);
    const download = await service.uploadUrl(request.auth.userId, uploadId);
    return reply.header("cache-control", "no-store").send(download);
  });

  app.get("/attachments/:attachmentId/url", async (request, reply) => {
    const { attachmentId } = attachmentParams.parse(request.params);
    const { variant } = urlQuery.parse(request.query);
    const download = await service.attachmentUrl(request.auth.userId, attachmentId, variant);
    return reply.header("cache-control", "no-store").send(download);
  });

  done();
};
