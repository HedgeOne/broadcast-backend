import type { Message } from "../../db/schema/index.js";
import type { SystemEvent } from "../groups/groups.types.js";
import type { AttachmentDto } from "../media/media.types.js";

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
  // Media messages: the file's metadata. Never a URL; readers request a
  // short-lived download URL for the attachment id.
  attachment: AttachmentDto | null;
  system: SystemEvent | null;
  deleted: boolean;
  deletedBy: string | null;
  // Whether the requesting user starred it. Only in responses to that user
  // (history, sends, starred lists); absent from events shared with others.
  starred?: boolean;
}

export function toMessageDto(
  message: Message,
  extras: Partial<
    Pick<MessageDto, "replyTo" | "mentions" | "reactions" | "attachment" | "starred">
  > = {},
): MessageDto {
  const deleted = message.deletedAt !== null;
  return {
    ...(extras.starred !== undefined ? { starred: !deleted && extras.starred } : {}),
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
    attachment: deleted ? null : (extras.attachment ?? null),
    system: (message.systemEvent as SystemEvent | null) ?? null,
    deleted,
    deletedBy: message.deletedBy,
  };
}
