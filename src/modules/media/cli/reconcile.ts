import { config } from "../../../config/index.js";
import { closeDatabase, db } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { MediaRepository } from "../media.repository.js";
import { S3ObjectStorage } from "../media.storage.js";
import { MediaSweeper } from "../media.sweeper.js";

// Runs one media cleanup pass, then lists objects under the media prefixes
// (attachments and photos) that no pending or ready upload owns (older than a day). Reports by default;
// pass --delete to remove the orphans.
async function main(): Promise<void> {
  const { bucket, region } = config.media;
  if (!bucket) {
    console.log("AWS_S3_BUCKET is not set");
    process.exitCode = 1;
    return;
  }
  const remove = process.argv.includes("--delete");
  const sweeper = new MediaSweeper(
    new MediaRepository(db),
    new S3ObjectStorage(bucket, region),
    logger.child({ component: "media" }),
    config.media.unattachedTtlSeconds,
  );

  const swept = await sweeper.sweep();
  console.log(
    `cleanup: ${swept.expired} upload(s) expired, ${swept.objectsDeleted} object(s) deleted, ` +
      `${swept.objectDeleteFailures} delete failure(s)`,
  );

  const { scanned, orphans } = await sweeper.reconcileOrphans({ dryRun: !remove });
  console.log(
    `reconcile: ${scanned} object(s) scanned, ${orphans.length} orphan(s) ${remove ? "deleted" : "found (run with --delete to remove)"}`,
  );
}

try {
  await main();
} finally {
  await closeDatabase();
}
