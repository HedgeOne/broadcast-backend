import type { MessageDto } from "../modules/messages/messages.types.js";

// Server → client events. The socket is a delivery hint, never the source of
// truth: clients reconcile with the REST API after (re)connecting.
export type RealtimeEvent =
  | { type: "connection.ready" }
  | { type: "pong" }
  | { type: "message.new"; chatId: string; message: MessageDto }
  | {
      type: "receipt.updated";
      chatId: string;
      userId: string;
      deliveredSequence: number;
      // null when read receipts are hidden between these two users.
      readSequence: number | null;
    };
