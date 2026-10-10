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
  | { type: "chat.removed"; chatId: string };
