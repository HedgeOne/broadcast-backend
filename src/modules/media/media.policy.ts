// What may be uploaded. Anything not listed (executables, scripts, HTML,
// SVG, installers, disk images, …) is refused. The declared MIME type must
// be listed for the declared category, the file name's extension must
// belong to it, and after upload the object's first bytes must match the
// type's signature.

export type MediaCategory = "image" | "video" | "audio" | "document";

export const MEDIA_CATEGORIES: readonly MediaCategory[] = ["image", "video", "audio", "document"];

// What an upload is for. Photos (profile, group, broadcast list) are kept
// apart from message attachments: their own key prefix, a narrower set of
// types and a smaller size limit, and they can never be sent as messages.
export type MediaPurpose = "attachment" | "profile_photo" | "group_photo" | "broadcast_list_photo";
export type PhotoPurpose = Exclude<MediaPurpose, "attachment">;

export const MEDIA_PURPOSES: readonly MediaPurpose[] = [
  "attachment",
  "profile_photo",
  "group_photo",
  "broadcast_list_photo",
];

export const STORAGE_PREFIXES: Record<MediaPurpose, string> = {
  attachment: "attachments/",
  profile_photo: "profile-photos/",
  group_photo: "group-photos/",
  broadcast_list_photo: "broadcast-list-photos/",
};

// Photos are cropped and resized on the device before upload, so these
// bounds are generous for a square image and its avatar thumbnail.
export const PHOTO_MIME_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// The largest file an upload for `purpose` may be.
export function maxBytesFor(purpose: MediaPurpose, attachmentMaxBytes: number): number {
  return purpose === "attachment"
    ? attachmentMaxBytes
    : Math.min(PHOTO_MAX_BYTES, attachmentMaxBytes);
}

type Signature = (bytes: Uint8Array) => boolean;

interface AllowedType {
  category: MediaCategory;
  extensions: readonly string[];
  signature: Signature;
}

export const SIGNATURE_BYTES = 64;
export const FILE_NAME_MAX = 255;

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

// ISO base media (MP4, MOV, 3GP, M4A, HEIC): a box size, then "ftyp".
const isoMedia: Signature = (b) => startsWith(b, ascii("ftyp"), 4);
const quickTime: Signature = (b) =>
  isoMedia(b) ||
  ["moov", "mdat", "wide", "free", "skip"].some((box) => startsWith(b, ascii(box), 4));
const ebml: Signature = (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]);
const riff =
  (form: string): Signature =>
  (b) =>
    startsWith(b, ascii("RIFF")) && startsWith(b, ascii(form), 8);
const zip: Signature = (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
const ole: Signature = (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const mpegAudio: Signature = (b) =>
  startsWith(b, ascii("ID3")) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);
// Plain text: no NUL bytes at the start (binary files almost always have
// them early).
const text: Signature = (b) => !b.includes(0);

const TYPES: Record<string, AllowedType> = {
  "image/jpeg": {
    category: "image",
    extensions: ["jpg", "jpeg"],
    signature: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  "image/png": {
    category: "image",
    extensions: ["png"],
    signature: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  "image/gif": {
    category: "image",
    extensions: ["gif"],
    signature: (b) => startsWith(b, ascii("GIF8")),
  },
  "image/webp": { category: "image", extensions: ["webp"], signature: riff("WEBP") },
  "image/heic": { category: "image", extensions: ["heic", "heif"], signature: isoMedia },
  "image/heif": { category: "image", extensions: ["heif", "heic"], signature: isoMedia },

  "video/mp4": { category: "video", extensions: ["mp4", "m4v"], signature: isoMedia },
  "video/quicktime": { category: "video", extensions: ["mov", "qt"], signature: quickTime },
  "video/3gpp": { category: "video", extensions: ["3gp"], signature: isoMedia },
  "video/webm": { category: "video", extensions: ["webm"], signature: ebml },

  "audio/mpeg": { category: "audio", extensions: ["mp3"], signature: mpegAudio },
  "audio/mp4": { category: "audio", extensions: ["m4a", "mp4"], signature: isoMedia },
  "audio/x-m4a": { category: "audio", extensions: ["m4a"], signature: isoMedia },
  "audio/m4a": { category: "audio", extensions: ["m4a"], signature: isoMedia },
  "audio/aac": {
    category: "audio",
    extensions: ["aac"],
    signature: (b) => b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0,
  },
  "audio/ogg": {
    category: "audio",
    extensions: ["ogg", "oga", "opus"],
    signature: (b) => startsWith(b, ascii("OggS")),
  },
  "audio/opus": {
    category: "audio",
    extensions: ["opus"],
    signature: (b) => startsWith(b, ascii("OggS")),
  },
  "audio/wav": { category: "audio", extensions: ["wav"], signature: riff("WAVE") },
  "audio/x-wav": { category: "audio", extensions: ["wav"], signature: riff("WAVE") },
  "audio/amr": {
    category: "audio",
    extensions: ["amr"],
    signature: (b) => startsWith(b, ascii("#!AMR")),
  },
  "audio/webm": { category: "audio", extensions: ["webm"], signature: ebml },

  "application/pdf": {
    category: "document",
    extensions: ["pdf"],
    signature: (b) => startsWith(b, ascii("%PDF-")),
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    category: "document",
    extensions: ["docx"],
    signature: zip,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    category: "document",
    extensions: ["xlsx"],
    signature: zip,
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    category: "document",
    extensions: ["pptx"],
    signature: zip,
  },
  "application/msword": { category: "document", extensions: ["doc"], signature: ole },
  "application/vnd.ms-excel": { category: "document", extensions: ["xls"], signature: ole },
  "application/vnd.ms-powerpoint": { category: "document", extensions: ["ppt"], signature: ole },
  "application/vnd.oasis.opendocument.text": {
    category: "document",
    extensions: ["odt"],
    signature: zip,
  },
  "application/vnd.oasis.opendocument.spreadsheet": {
    category: "document",
    extensions: ["ods"],
    signature: zip,
  },
  "application/vnd.oasis.opendocument.presentation": {
    category: "document",
    extensions: ["odp"],
    signature: zip,
  },
  "application/rtf": {
    category: "document",
    extensions: ["rtf"],
    signature: (b) => startsWith(b, ascii("{\\rtf")),
  },
  "application/zip": { category: "document", extensions: ["zip"], signature: zip },
  "text/plain": { category: "document", extensions: ["txt", "text", "log", "md"], signature: text },
  "text/csv": { category: "document", extensions: ["csv"], signature: text },
};

// Some pickers report these for known files; they are mapped to the
// canonical type before checking.
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/vnd.wave": "audio/wav",
  "application/x-zip-compressed": "application/zip",
  "text/comma-separated-values": "text/csv",
  "application/csv": "text/csv",
};

export function normalizeMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALIASES[base] ?? base;
}

export function extensionOf(fileName: string | null): string | null {
  if (!fileName) return null;
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match?.[1]?.toLowerCase() ?? null;
}

// The name as shown to recipients: no directories, control characters or
// surrounding whitespace. Never used in storage keys.
export function sanitizeFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, FILE_NAME_MAX);
}

export type PolicyFailure = "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "EXTENSION_MISMATCH";

// Checks a declared upload. Returns the canonical MIME type or the reason
// it was refused.
export function checkDeclared(input: {
  purpose?: MediaPurpose;
  category: MediaCategory;
  mimeType: string;
  fileName: string | null;
}): { ok: true; mimeType: string } | { ok: false; reason: PolicyFailure } {
  const mimeType = normalizeMimeType(input.mimeType);
  const allowed = TYPES[mimeType];
  if (!allowed) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  if (input.purpose && input.purpose !== "attachment") {
    if (input.category !== "image") return { ok: false, reason: "TYPE_MISMATCH" };
    if (!PHOTO_MIME_TYPES.includes(mimeType)) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  if (allowed.category !== input.category) return { ok: false, reason: "TYPE_MISMATCH" };
  const extension = extensionOf(input.fileName);
  // Documents need a matching extension (it decides how they're opened);
  // camera media may arrive without one.
  if (extension ? !allowed.extensions.includes(extension) : input.category === "document") {
    return { ok: false, reason: "EXTENSION_MISMATCH" };
  }
  return { ok: true, mimeType };
}

// Whether the uploaded bytes look like the declared type.
export function matchesSignature(mimeType: string, start: Uint8Array): boolean {
  const allowed = TYPES[mimeType];
  return allowed !== undefined && start.length > 0 && allowed.signature(start);
}

export function allowedMimeTypes(category: MediaCategory): string[] {
  return Object.entries(TYPES)
    .filter(([, type]) => type.category === category)
    .map(([mimeType]) => mimeType);
}
