import type { BroadcastMessageRecipient } from "../../db/schema/index.js";
import type { MessageKind } from "../messages/messages.types.js";

export type RecipientStatus = BroadcastMessageRecipient["status"];

// Cumulative counts over a broadcast's recipient snapshot: `accepted`
// includes delivered and read, `delivered` includes read. `read` only
// counts recipients whose read state the owner may see (both allow read
// receipts); the others count as delivered.
export interface DeliverySummary {
  total: number;
  pending: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  retryable: number;
}

// sending: some recipients pending. completed: everyone accepted.
// partial: some accepted, some failed. failed: nobody accepted.
export type BroadcastState = "sending" | "completed" | "partial" | "failed";

export function stateOf(summary: DeliverySummary): BroadcastState {
  if (summary.pending > 0) return "sending";
  if (summary.failed === 0) return "completed";
  return summary.accepted > 0 ? "partial" : "failed";
}

// One send to a list, as its owner sees it in the list's history. The body
// is the owner's copy (from a direct message it was delivered as, or the
// pending copy); `ciphertext` is empty when every copy was deleted.
export interface BroadcastDto {
  id: string;
  listId: string;
  clientMessageId: string;
  // Order of acceptance within the owner's broadcasts; the cursor for
  // shared content and starred pages.
  sequence: number;
  type: MessageKind;
  ciphertext: string;
  createdAt: string;
  completedAt: string | null;
  state: BroadcastState;
  summary: DeliverySummary;
  attachment: BroadcastAttachmentDto | null;
  // The owner starred a copy of it (see starredBroadcast).
  starred: boolean;
  // False once the owner cleared the list's history past it; such updates
  // must not bring it back into the list view.
  inHistory: boolean;
}

// The file a media broadcast shared. The owner fetches it through their
// own upload (GET /media/uploads/:id/url); `available` turns false once
// every recipient's copy was deleted and the file was removed.
export interface BroadcastAttachmentDto {
  uploadId: string;
  thumbnailUploadId: string | null;
  type: MessageKind;
  mimeType: string;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  available: boolean;
}

export interface BroadcastListDto {
  id: string;
  name: string;
  // The list photo's version, or null. Owner-only, fetched through
  // GET /broadcasts/:listId/photo; recipients never see it.
  photoId: string | null;
  recipientCount: number;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastBroadcast: BroadcastDto | null;
}

export interface BroadcastRecipientDto {
  userId: string;
  displayName: string | null;
  photoId: string | null;
  // False when the account is inactive or the owner blocked it.
  available: boolean;
  addedAt: string;
}

export interface BroadcastListDetails extends BroadcastListDto {
  maxRecipients: number;
  recipients: BroadcastRecipientDto[];
}

// One recipient's outcome for one broadcast. `status` is 'delivered' (and
// readAt null) when the owner may not see their read state. `chatId` is
// the existing direct chat the message was delivered in.
export interface RecipientReportDto {
  userId: string;
  displayName: string | null;
  photoId: string | null;
  status: RecipientStatus;
  chatId: string | null;
  attemptCount: number;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  retryable: boolean;
}
