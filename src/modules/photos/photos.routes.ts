import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";

import { photoRef, photoUrlQuery } from "../media/media.schemas.js";
import type { PhotosService } from "./photos.service.js";

export interface PhotosRoutesOptions {
  service: PhotosService;
}

const userParams = z.object({ userId: z.uuid() });
const groupParams = z.object({ chatId: z.uuid() });
const listParams = z.object({ listId: z.uuid() });

// Profile photo management and photo downloads. Registered without a
// prefix: the paths live under the resources they belong to. Group and
// list photos are set through the groups and broadcasts routes, which own
// those permissions. Signed URLs are never logged or cached.
export const photosRoutes: FastifyPluginCallback<PhotosRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  app.put("/users/me/photo", async (request) => {
    const photo = photoRef.parse(request.body);
    return { user: await service.setUserPhoto(request.auth.userId, photo) };
  });

  app.delete("/users/me/photo", async (request) => {
    return { user: await service.removeUserPhoto(request.auth.userId) };
  });

  app.get("/users/:userId/photo", async (request, reply) => {
    const { userId } = userParams.parse(request.params);
    const { variant } = photoUrlQuery.parse(request.query);
    const download = await service.userPhotoUrl(request.auth.userId, userId, variant);
    return reply.header("cache-control", "no-store").send(download);
  });

  app.get("/groups/:chatId/photo", async (request, reply) => {
    const { chatId } = groupParams.parse(request.params);
    const { variant } = photoUrlQuery.parse(request.query);
    const download = await service.groupPhotoUrl(request.auth.userId, chatId, variant);
    return reply.header("cache-control", "no-store").send(download);
  });

  app.get("/broadcasts/:listId/photo", async (request, reply) => {
    const { listId } = listParams.parse(request.params);
    const { variant } = photoUrlQuery.parse(request.query);
    const download = await service.listPhotoUrl(request.auth.userId, listId, variant);
    return reply.header("cache-control", "no-store").send(download);
  });

  done();
};
