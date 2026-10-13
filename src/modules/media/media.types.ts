import type { MediaUpload, MessageAttachment } from "../../db/schema/index.js";

// An upload as its owner sees it. Never includes the storage key.
export interface UploadDto {
  id: string;
  clientUploadId: string;
  purpose: MediaUpload["purpose"];
  category: MediaUpload["category"];
  mimeType: string;
  fileName: string | null;
  // The verified size once ready, otherwise the declared size.
  fileSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: MediaUpload["status"];
  failureCode: string | null;
  createdAt: string;
  uploadExpiresAt: string;
}

// What a message carries, as every reader sees it. No URL: readers ask for
// a short-lived download URL, which is authorized through the message.
export interface AttachmentDto {
  id: string;
  type: MessageAttachment["type"];
  mimeType: string;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
}

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

export function toUploadDto(upload: MediaUpload): UploadDto {
  return {
    id: upload.id,
    clientUploadId: upload.clientUploadId,
    purpose: upload.purpose,
    category: upload.category,
    mimeType: upload.mimeType,
    fileName: upload.fileName,
    fileSize: upload.fileSize ?? upload.declaredSize,
    width: upload.width,
    height: upload.height,
    durationMs: upload.durationMs,
    status: upload.status,
    failureCode: upload.failureCode,
    createdAt: upload.createdAt.toISOString(),
    uploadExpiresAt: upload.uploadExpiresAt.toISOString(),
  };
}

export function toAttachmentDto(attachment: MessageAttachment): AttachmentDto {
  return {
    id: attachment.id,
    type: attachment.type,
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    hasThumbnail: attachment.thumbnailStorageKey !== null,
  };
}
