import {
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import { config } from "../../../config/index.js";
import { matchesSignature, SIGNATURE_BYTES } from "../media.policy.js";
import { newStorageKey } from "../media.service.js";
import { S3ObjectStorage } from "../media.storage.js";

// End-to-end check of the configured media bucket with the server's own
// credentials: the bucket is reachable and not public, a presigned PUT
// stores exactly the signed size and type, a presigned GET returns the
// bytes, unsigned access is refused, and the test object is removed.
// Prints outcomes only — never URLs, keys or credentials.

// A real 1x1 PNG.
const SAMPLE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;

function report(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

function errorName(error: unknown): string {
  if (error instanceof S3ServiceException) {
    return `${error.name}, HTTP ${error.$metadata.httpStatusCode ?? "?"}`;
  }
  return error instanceof Error ? error.name : "error";
}

async function main(): Promise<void> {
  const { bucket, region } = config.media;
  if (!bucket) {
    console.log("FAIL AWS_S3_BUCKET is not set");
    process.exitCode = 1;
    return;
  }
  console.log(`bucket ${bucket} in ${region}`);

  const client = new S3Client({ region });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    report(true, "bucket reachable with server credentials");
  } catch (error) {
    // HeadBucket needs s3:ListBucket, which the app only uses for orphan
    // reconciliation; the object round trip below is the real test.
    const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
    if (status !== 403) {
      report(false, "bucket reachable with server credentials", errorName(error));
      process.exitCode = 1;
      return;
    }
    console.log("skip bucket listing not permitted (s3:ListBucket); testing objects directly");
  }

  try {
    const block = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const settings = block.PublicAccessBlockConfiguration;
    const all =
      settings?.BlockPublicAcls === true &&
      settings.IgnorePublicAcls === true &&
      settings.BlockPublicPolicy === true &&
      settings.RestrictPublicBuckets === true;
    report(all, "Block Public Access fully enabled");
  } catch (error) {
    // Reading the setting needs s3:GetBucketPublicAccessBlock, which the
    // app's credentials don't require; the unsigned-GET check below still
    // proves objects aren't public.
    console.log(`skip Block Public Access setting not readable (${errorName(error)})`);
  }

  const storage = new S3ObjectStorage(bucket, region);
  const key = newStorageKey();
  try {
    const upload = await storage.presignUpload({
      key,
      contentType: "image/png",
      contentLength: SAMPLE.length,
      expiresInSeconds: 120,
    });

    const wrongSize = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: Buffer.concat([SAMPLE, Buffer.from("extra")]),
    });
    report(
      wrongSize.status === 403,
      "presigned PUT refuses a different size",
      `${wrongSize.status}`,
    );

    const wrongType = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Type": "text/html" },
      body: SAMPLE,
    });
    report(
      wrongType.status === 403,
      "presigned PUT refuses a different type",
      `${wrongType.status}`,
    );

    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: SAMPLE });
    report(put.ok, "presigned PUT stores the object", `${put.status}`);

    const head = await storage.head(key);
    report(
      head?.size === SAMPLE.length && head.contentType === "image/png",
      "HEAD reports the signed size and type",
    );

    const start = await storage.readStart(key, SIGNATURE_BYTES);
    report(matchesSignature("image/png", start), "file signature check reads the object");

    const url = await storage.presignDownload({
      key,
      expiresInSeconds: 60,
      contentType: "image/png",
      fileName: "check.png",
    });
    const get = await fetch(url);
    const body = Buffer.from(await get.arrayBuffer());
    report(get.ok && body.equals(SAMPLE), "presigned GET returns the same bytes", `${get.status}`);
    report(
      (get.headers.get("content-disposition") ?? "").startsWith("attachment"),
      "download is served as an attachment",
    );

    const unsigned = await fetch(`https://${bucket}.s3.${region}.amazonaws.com/${key}`);
    report(
      unsigned.status === 403,
      "unsigned GET is refused (object not public)",
      `${unsigned.status}`,
    );
  } catch (error) {
    report(false, "round trip", errorName(error));
  } finally {
    try {
      await storage.delete(key);
      report(true, "DELETE accepted");
      report((await storage.head(key)) === null, "test object gone");
    } catch (error) {
      report(false, "test object deleted", errorName(error));
    }
  }

  if (failures > 0) process.exitCode = 1;
  console.log(failures === 0 ? "media storage check passed" : `${failures} check(s) failed`);
}

await main();
