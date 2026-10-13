import type {
  ObjectStorage,
  PresignedUpload,
  StoredObject,
} from "../../src/modules/media/media.storage.js";

const BASE = "https://fake-s3.invalid/";

interface Signed {
  contentType: string;
  contentLength: number;
}

// In-memory stand-in for the S3 bucket. `put` behaves like a presigned PUT
// (S3 refuses a body whose size or type differs from what was signed);
// `plant` writes bytes directly, standing in for anything that bypasses
// the signature.
export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();
  readonly deleted: string[] = [];
  failDeletes = false;
  private readonly signed = new Map<string, Signed>();

  presignUpload(input: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<PresignedUpload> {
    this.signed.set(input.key, {
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
    return Promise.resolve({
      url: `${BASE}${input.key}?X-Amz-Signature=put`,
      method: "PUT",
      headers: { "Content-Type": input.contentType },
    });
  }

  // Returns the HTTP status S3 would.
  put(url: string, body: Buffer, contentType: string): number {
    const key = keyOf(url);
    const signed = this.signed.get(key);
    if (!signed || signed.contentType !== contentType || signed.contentLength !== body.length) {
      return 403;
    }
    this.plant(key, body, contentType);
    return 200;
  }

  plant(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType, lastModified: new Date() });
  }

  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { size: object.body.length, contentType: object.contentType } : null,
    );
  }

  readStart(key: string, length: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new Error("NoSuchKey"));
    return Promise.resolve(new Uint8Array(object.body.subarray(0, length)));
  }

  presignDownload(input: {
    key: string;
    expiresInSeconds: number;
    contentType: string;
  }): Promise<string> {
    return Promise.resolve(
      `${BASE}${input.key}?response-content-type=${encodeURIComponent(input.contentType)}` +
        `&X-Amz-Expires=${input.expiresInSeconds}&X-Amz-Signature=get`,
    );
  }

  // The object a download URL points at.
  get(url: string): Buffer | undefined {
    return this.objects.get(keyOf(url))?.body;
  }

  delete(key: string): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error("simulated S3 outage"));
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<{ objects: { key: string; lastModified: Date }[]; cursor: null }> {
    return Promise.resolve({
      objects: [...this.objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, lastModified: object.lastModified })),
      cursor: null,
    });
  }
}

function keyOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

// Minimal files whose first bytes match their type.
export const SAMPLES = {
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]),
  pdf: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 0x20)]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(80, 0)]),
  m4a: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(80, 0)]),
  // The start of a Windows executable (DOS "MZ" header).
  exe: Buffer.concat([
    Buffer.from([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff,
    ]),
    Buffer.alloc(90, 0),
  ]),
};
