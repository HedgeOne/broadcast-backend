import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";

import type { RealtimeEvent } from "./events.js";

const CHANNEL_PREFIX = "rt:user:";

export interface RealtimePublisher {
  publish(userId: string, event: RealtimeEvent): Promise<void>;
}

// Fans events out to every socket a user has open, across server instances:
// events are published to a per-user Redis channel and each instance
// delivers them to its local sockets. If Redis is unreachable, delivery
// falls back to this instance only; clients still converge by syncing.
export class RealtimeHub implements RealtimePublisher {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly subscriber: Redis;
  private readonly subscribed: Promise<void>;

  constructor(
    private readonly redis: Redis,
    private readonly log: FastifyBaseLogger,
  ) {
    // Subscriptions need their own connection; queue the subscribe until
    // Redis is reachable and resubscribe automatically after reconnects.
    this.subscriber = redis.duplicate({ enableOfflineQueue: true, lazyConnect: false });
    this.subscriber.on("error", (error: Error) => {
      this.log.warn({ err: error.message }, "realtime subscriber error");
    });
    this.subscriber.on("pmessage", (_pattern: string, channel: string, payload: string) => {
      this.deliverLocal(channel.slice(CHANNEL_PREFIX.length), payload);
    });
    this.subscribed = this.subscriber.psubscribe(`${CHANNEL_PREFIX}*`).then(
      () => undefined,
      (error: unknown) => {
        this.log.warn({ err: error instanceof Error ? error.message : error }, "psubscribe failed");
      },
    );
  }

  // Resolves once cross-instance delivery is active (used by tests).
  ready(): Promise<void> {
    return this.subscribed;
  }

  register(userId: string, socket: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socket);
  }

  unregister(userId: string, socket: WebSocket): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(userId);
  }

  async publish(userId: string, event: RealtimeEvent): Promise<void> {
    const payload = JSON.stringify(event);
    try {
      await this.redis.publish(`${CHANNEL_PREFIX}${userId}`, payload);
    } catch (error) {
      this.log.warn(
        { err: error instanceof Error ? error.message : error },
        "realtime publish failed; delivering locally",
      );
      this.deliverLocal(userId, payload);
    }
  }

  private deliverLocal(userId: string, payload: string): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  close(): void {
    for (const set of this.sockets.values()) {
      for (const socket of set) socket.close(1001, "server shutting down");
    }
    this.sockets.clear();
    this.subscriber.disconnect();
  }
}
