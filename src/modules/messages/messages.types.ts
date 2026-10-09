import type { Message } from "../../db/schema/index.js";

export type MessageKind = Message["type"];

// Wire shape. `ciphertext` is the opaque message body, base64-encoded; the
// server never interprets it.
export interface MessageDto {
  id: string;
  chatId: string;
  senderId: string;
  clientMessageId: string;
  sequence: number;
  type: MessageKind;
  ciphertext: string;
  createdAt: string;
}

export function toMessageDto(message: Message): MessageDto {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    sequence: message.sequence,
    type: message.type,
    ciphertext: message.ciphertext.toString("base64"),
    createdAt: message.createdAt.toISOString(),
  };
}
