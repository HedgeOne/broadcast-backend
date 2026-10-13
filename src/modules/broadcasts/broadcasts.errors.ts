import { AppError } from "../../lib/errors.js";

// Client-facing broadcast-list errors. Messages are user-safe; codes are
// stable.
export const broadcastErrors = {
  // Also returned for other people's and deleted lists, so a list's
  // existence is never revealed.
  listNotFound: () =>
    new AppError(404, "BROADCAST_LIST_NOT_FOUND", "This broadcast list is not available."),

  broadcastNotFound: () =>
    new AppError(404, "BROADCAST_NOT_FOUND", "This broadcast is not available."),

  // Stars live on the delivered copies; none is left to star.
  notStarrable: () =>
    new AppError(
      409,
      "BROADCAST_NOT_STARRABLE",
      "This broadcast can be starred once it's delivered to someone.",
    ),

  recipientNotFound: () =>
    new AppError(404, "RECIPIENT_NOT_FOUND", "This person isn't on the broadcast list."),

  invalidRecipients: () =>
    new AppError(400, "INVALID_RECIPIENTS", "Choose at least one other person."),

  // Inactive, or has blocked the owner. One code for both, so a block is
  // never revealed.
  recipientsUnavailable: (userIds: string[]) =>
    new AppError(422, "RECIPIENTS_UNAVAILABLE", "Some people can't be added to this list.", {
      userIds,
    }),

  recipientsBlocked: (userIds: string[]) =>
    new AppError(422, "RECIPIENTS_BLOCKED", "Unblock these people to add them.", { userIds }),

  listFull: (limit: number) =>
    new AppError(
      409,
      "BROADCAST_LIST_FULL",
      `Broadcast lists can have up to ${limit} recipients.`,
      {
        limit,
      },
    ),

  noRecipients: () =>
    new AppError(409, "NO_RECIPIENTS", "Add at least one recipient before sending."),

  clientRequestConflict: () =>
    new AppError(409, "CLIENT_REQUEST_CONFLICT", "This request ID was already used."),

  clientMessageIdConflict: () =>
    new AppError(
      409,
      "CLIENT_MESSAGE_ID_CONFLICT",
      "This message ID was already used for another broadcast list.",
    ),
};
