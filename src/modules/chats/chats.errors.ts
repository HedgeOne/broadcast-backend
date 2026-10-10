import { AppError } from "../../lib/errors.js";

// Client-facing messaging errors. Messages are user-safe; codes are stable.
export const chatErrors = {
  chatNotFound: () => new AppError(404, "CHAT_NOT_FOUND", "This conversation is not available."),

  userNotFound: () => new AppError(404, "USER_NOT_FOUND", "This account is not available."),

  cannotMessageSelf: () =>
    new AppError(400, "CANNOT_MESSAGE_SELF", "You can't start a conversation with yourself."),

  // The caller blocked the other user; they can unblock to continue.
  blockedByYou: () =>
    new AppError(403, "BLOCKED", "You blocked this account. Unblock it to send messages."),

  // The other user blocked the caller or is no longer active. Deliberately
  // indistinguishable so a block is never revealed.
  recipientUnavailable: () =>
    new AppError(403, "RECIPIENT_UNAVAILABLE", "You can't message this account."),

  messageNotFound: () => new AppError(404, "MESSAGE_NOT_FOUND", "This message is not available."),

  // Missing, deleted, a system event, or from before the sender joined.
  replyUnavailable: () =>
    new AppError(400, "REPLY_UNAVAILABLE", "The message you're replying to is not available."),

  mentionsNotAllowed: () =>
    new AppError(400, "MENTIONS_NOT_ALLOWED", "Mentions are only available in groups."),

  invalidMentions: (userIds: string[]) =>
    new AppError(400, "INVALID_MENTIONS", "You can only mention current group members.", {
      userIds,
    }),

  reactionNotAllowed: () =>
    new AppError(400, "REACTION_NOT_ALLOWED", "You can't react to this message."),

  deleteForbidden: () =>
    new AppError(403, "MESSAGE_DELETE_FORBIDDEN", "You can't delete this message."),

  clientMessageIdConflict: () =>
    new AppError(
      409,
      "CLIENT_MESSAGE_ID_CONFLICT",
      "This message ID was already used for another conversation.",
    ),
};
