import fp from "fastify-plugin";
import type { WebSocket } from "ws";

import { redis } from "../redis/client.js";
import type { RealtimeEvent } from "./events.js";
import { RealtimeHub, type RealtimePublisher } from "./hub.js";

export type { RealtimeEvent } from "./events.js";
export type { RealtimePublisher } from "./hub.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

declare module "fastify" {
  interface FastifyInstance {
    realtime: RealtimePublisher;
    realtimeHub: RealtimeHub;
  }
}

function send(socket: WebSocket, event: RealtimeEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

// Authenticated WebSocket at /ws. Requires the auth module (app.authenticate)
// and @fastify/websocket to be registered first. The access token is sent in
// the Authorization header of the upgrade request, never in the URL.
export const realtimeModule = fp(
  (app, _options, done) => {
    const hub = new RealtimeHub(redis, app.log.child({ component: "realtime" }));
    app.decorate("realtime", hub as RealtimePublisher);
    app.decorate("realtimeHub", hub);

    app.addHook("onClose", (_instance, hookDone) => {
      hub.close();
      hookDone();
    });

    app.get("/ws", { websocket: true, preValidation: app.authenticate }, (socket, request) => {
      const { userId } = request.auth;
      hub.register(userId, socket);

      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);

      socket.on("message", (raw: Buffer) => {
        let message: unknown;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (typeof message === "object" && message !== null && "type" in message) {
          if (message.type === "ping") send(socket, { type: "pong" });
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        hub.unregister(userId, socket);
      });

      send(socket, { type: "connection.ready" });
    });

    done();
  },
  { name: "realtime", dependencies: ["auth"] },
);
