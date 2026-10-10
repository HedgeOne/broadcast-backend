import type { GroupInfo } from "../groups/groups.types.js";
import type { MessageDto } from "../messages/messages.types.js";

export interface PeerProfile {
  id: string;
  displayName: string | null;
  // False when the account is disabled or deleted.
  available: boolean;
  blockedByMe: boolean;
}

interface ChatSummaryBase {
  id: string;
  // The latest message the caller may see (tombstones and system events
  // included).
  lastMessage: MessageDto | null;
  // Sender's current display name, for "Name: text" previews in groups.
  lastSenderName: string | null;
  lastSequence: number;
  // Messages from others after the caller's read pointer; system events
  // and deleted messages don't count.
  unreadCount: number;
  muted: boolean;
  lastReadSequence: number;
  // Direct: the peer's pointers. Group: the lowest pointer across the other
  // active members, i.e. how far everyone has received/read.
  peerDeliveredSequence: number;
  // null when read receipts are hidden (direct chats where either user
  // turned them off).
  peerReadSequence: number | null;
  createdAt: string;
  // Server time of the last message, or creation time for empty chats.
  lastActivityAt: string;
}

export interface DirectChatSummary extends ChatSummaryBase {
  type: "direct";
  peer: PeerProfile;
}

export interface GroupChatSummary extends ChatSummaryBase {
  type: "group";
  group: GroupInfo;
}

// One row of the chat list, from the caller's point of view.
export type ChatSummary = DirectChatSummary | GroupChatSummary;
