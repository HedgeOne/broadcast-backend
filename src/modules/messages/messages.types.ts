import type { Message } from "../../db/schema/index.js";
import type { SystemEvent } from "../groups/groups.types.js";

export type MessageKind = Message["type"];

// The replied-to message as the reader may see it. `available` is false
// when it was sent before the reader joined (history hidden) or deleted.
export interface ReplyPreviewDto {
  id: string;
  available: boolean;
  senderId: string | null;
  type: MessageKind | null;
  ciphertext: string | null;
}

export interface ReactionDto {
  userId: string;
  emoji: string;
}

// Wire shape. `ciphertext` is the opaque message body, base64-encoded; the
// server never interprets it. Deleted messages keep their place (sequence)
// with an empty body.
export interface MessageDto {
  id: string;
  chatId: string;
  senderId: string;
  clientMessageId: string;
  sequence: number;
  type: MessageKind;
  ciphertext: string;
  createdAt: string;
  replyTo: ReplyPreviewDto | null;
  // Validated member ids; the body refers to them as @{userId} tokens.
  mentions: string[];
  reactions: ReactionDto[];
  system: SystemEvent | null;
  deleted: boolean;
  deletedBy: string | null;
}

export function toMessageDto(
  message: Message,
  extras: Partial<Pick<MessageDto, "replyTo" | "mentions" | "reactions">> = {},
): MessageDto {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    sequence: message.sequence,
    type: message.type,
    ciphertext: deleted ? "" : message.ciphertext.toString("base64"),
    createdAt: message.createdAt.toISOString(),
    replyTo: extras.replyTo ?? null,
    mentions: deleted ? [] : (extras.mentions ?? []),
    reactions: deleted ? [] : (extras.reactions ?? []),
    system: (message.systemEvent as SystemEvent | null) ?? null,
    deleted,
    deletedBy: message.deletedBy,
  };
}
