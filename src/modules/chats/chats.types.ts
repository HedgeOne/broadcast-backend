import type { MessageDto } from "../messages/messages.types.js";

export interface PeerProfile {
  id: string;
  displayName: string | null;
  // False when the account is disabled or deleted.
  available: boolean;
  blockedByMe: boolean;
}

// One row of the chat list, from the caller's point of view.
export interface ChatSummary {
  id: string;
  type: "direct";
  peer: PeerProfile;
  lastMessage: MessageDto | null;
  lastSequence: number;
  // Messages from the peer after the caller's read pointer.
  unreadCount: number;
  muted: boolean;
  lastReadSequence: number;
  peerDeliveredSequence: number;
  // null when read receipts are hidden (either user turned them off).
  peerReadSequence: number | null;
  createdAt: string;
  // Server time of the last message, or creation time for empty chats.
  lastActivityAt: string;
}
