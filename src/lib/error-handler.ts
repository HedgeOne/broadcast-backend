import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { AppError, errorBody } from "./errors.js";

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message, error.details));
    }

    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return reply
        .code(400)
        .send(errorBody("VALIDATION_ERROR", "The request is invalid.", { issues }));
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode === 429) {
      return reply.code(429).send(errorBody("RATE_LIMITED", "Too many requests. Try again later."));
    }

    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(errorBody("BAD_REQUEST", error.message));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "Something went wrong."));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(errorBody("NOT_FOUND", "Route not found."));
  });
}
