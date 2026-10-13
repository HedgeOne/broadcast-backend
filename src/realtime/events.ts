import type { BroadcastDto } from "../modules/broadcasts/broadcasts.types.js";
import type { MessageDto } from "../modules/messages/messages.types.js";

// Server → client events. The socket is a delivery hint, never the source of
// truth: everything here is committed to Postgres before it is published,
// and clients reconcile with the REST API after (re)connecting. Events go
// only to users who are active members of the chat when they are sent.
export type RealtimeEvent =
  | { type: "connection.ready" }
  | { type: "pong" }
  | { type: "message.new"; chatId: string; message: MessageDto }
  | { type: "message.deleted"; chatId: string; message: MessageDto }
  | {
      type: "reaction.updated";
      chatId: string;
      messageId: string;
      userId: string;
      // null when the reaction was removed.
      emoji: string | null;
    }
  | {
      type: "receipt.updated";
      chatId: string;
      userId: string;
      deliveredSequence: number;
      // null when read receipts are hidden between these two users.
      readSequence: number | null;
    }
  // Groups: the lowest delivered/read pointer across active members, which
  // is what a sender's ticks show.
  | { type: "receipts.aggregate"; chatId: string; deliveredSequence: number; readSequence: number }
  // Group metadata, roles or membership changed: refetch the chat.
  | { type: "chat.updated"; chatId: string }
  // The user left, was removed, or the group was deleted.
  | { type: "chat.removed"; chatId: string }
  // Per-user state, sent only to that user's own devices: they cleared the
  // chat (messages at or below the sequence are gone from their view), or
  // starred / unstarred a message.
  | { type: "chat.cleared"; chatId: string; clearedThroughSequence: number }
  | { type: "message.starred"; chatId: string; messageId: string; starred: boolean }
  // Broadcast lists: sent only to the list owner's own devices. Recipients
  // only ever see the ordinary message.new in their direct chat.
  // accepted: recorded with its recipient snapshot. progress / completed:
  // deliveries written (completed once nothing is pending; the state says
  // whether some failed). delivered / read: recipient receipts. retry:
  // retryable failures re-queued.
  | {
      type: "broadcast.updated";
      listId: string;
      reason: "accepted" | "progress" | "completed" | "delivered" | "read" | "retry" | "starred";
      broadcast: BroadcastDto;
    }
  // Created, renamed, muted or recipients changed: refetch the list.
  | { type: "broadcast.list.updated"; listId: string }
  // The owner cleared the list's history: reload it.
  | { type: "broadcast.list.cleared"; listId: string }
  | { type: "broadcast.list.deleted"; listId: string };
