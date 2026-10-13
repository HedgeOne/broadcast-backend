import type { FastifyBaseLogger } from "fastify";

import { STORAGE_PREFIXES } from "./media.policy.js";
import type { MediaRepository } from "./media.repository.js";
import type { ObjectStorage } from "./media.storage.js";

const BATCH = 100;
// A session that never completed is kept this long past its URL expiry,
// so a client finishing a slow upload can still complete it.
const PENDING_GRACE_SECONDS = 3600;
// Orphan reconciliation leaves recent objects alone: their row may be
// committing right now.
const ORPHAN_MIN_AGE_MS = 24 * 3600 * 1000;

export interface SweepResult {
  expired: number;
  objectsDeleted: number;
  objectDeleteFailures: number;
}

// Deletes media no one can use any more: abandoned and refused uploads,
// uploads never sent within the unattached window, and uploads whose
// every referencing message was deleted (and that no pending broadcast
// still needs). Rows are marked first, under locks, then their objects
// are removed; a failed S3 delete is retried on the next run.
export class MediaSweeper {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly repo: MediaRepository,
    private readonly storage: ObjectStorage | null,
    private readonly log: FastifyBaseLogger,
    private readonly unattachedTtlSeconds: number,
  ) {}

  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { expired: 0, objectsDeleted: 0, objectDeleteFailures: 0 };
    if (this.sweeping || !this.storage) return result;
    this.sweeping = true;
    try {
      result.expired = await this.repo.expireUnused({
        pendingGraceSeconds: PENDING_GRACE_SECONDS,
        unattachedTtlSeconds: this.unattachedTtlSeconds,
        limit: BATCH,
      });
      for (const object of await this.repo.objectsToDelete(BATCH)) {
        try {
          await this.storage.delete(object.storageKey);
          await this.repo.markObjectDeleted(object.id);
          result.objectsDeleted += 1;
        } catch (error) {
          result.objectDeleteFailures += 1;
          this.log.warn(
            { err: error instanceof Error ? error.message : error, uploadId: object.id },
            "media object delete failed",
          );
        }
      }
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  // Objects under any media prefix (attachments, profile, group and list
  // photos) with no pending or ready upload row (e.g. left by a crash
  // between an S3 write and its database update). With dryRun nothing is
  // deleted.
  async reconcileOrphans(options: { dryRun: boolean; minAgeMs?: number }): Promise<{
    scanned: number;
    orphans: string[];
  }> {
    const storage = this.storage;
    if (!storage) return { scanned: 0, orphans: [] };
    const cutoff = Date.now() - (options.minAgeMs ?? ORPHAN_MIN_AGE_MS);
    const orphans: string[] = [];
    let scanned = 0;
    for (const prefix of Object.values(STORAGE_PREFIXES)) {
      let cursor: string | undefined;
      do {
        const page = await storage.list(prefix, cursor);
        scanned += page.objects.length;
        const old = page.objects.filter((object) => object.lastModified.getTime() < cutoff);
        const live = await this.repo.liveStorageKeys(old.map((object) => object.key));
        for (const object of old) {
          if (live.has(object.key)) continue;
          orphans.push(object.key);
          if (!options.dryRun) await storage.delete(object.key);
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
    }
    return { scanned, orphans };
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer || !this.storage) return;
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.log.error(
          { err: error instanceof Error ? error.message : error },
          "media sweep failed",
        );
      });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
