import { AppError } from "../../lib/errors.js";

// Client-facing group errors. Messages are user-safe; codes are stable.
export const groupErrors = {
  // Also returned to non-members, so a group's existence is never revealed.
  groupNotFound: () => new AppError(404, "GROUP_NOT_FOUND", "This group is not available."),

  forbidden: (action: string) =>
    new AppError(403, "GROUP_FORBIDDEN", "You don't have permission to do this in this group.", {
      action,
    }),

  onlyAdminsCanSend: () =>
    new AppError(403, "ONLY_ADMINS_CAN_SEND", "Only admins can send messages to this group."),

  memberNotFound: () =>
    new AppError(404, "MEMBER_NOT_FOUND", "This person isn't a member of the group."),

  cannotActOnSelf: () => new AppError(400, "CANNOT_ACT_ON_SELF", "You can't do this to yourself."),

  alreadyMembers: (userIds: string[]) =>
    new AppError(409, "ALREADY_MEMBER", "Some people are already in the group.", { userIds }),

  // Blocked (either way), inactive, or not accepting group adds. One code
  // for all, so a block is never revealed.
  participantsUnavailable: (userIds: string[]) =>
    new AppError(422, "PARTICIPANTS_UNAVAILABLE", "Some people can't be added to this group.", {
      userIds,
    }),

  blockedParticipants: (userIds: string[]) =>
    new AppError(422, "PARTICIPANTS_BLOCKED", "Unblock these people to add them.", { userIds }),

  groupFull: (limit: number) =>
    new AppError(409, "GROUP_FULL", `Groups can have up to ${limit} members.`, { limit }),

  invalidParticipants: () =>
    new AppError(400, "INVALID_PARTICIPANTS", "Choose at least one other person."),

  clientRequestConflict: () =>
    new AppError(409, "CLIENT_REQUEST_CONFLICT", "This request ID was already used."),

  // Unknown, expired, revoked or used up: one code, so tokens can't be probed.
  inviteInvalid: () =>
    new AppError(404, "INVITE_INVALID", "This invite link is invalid or has expired."),

  invitesDisabled: () =>
    new AppError(403, "INVITES_DISABLED", "Invite links are turned off for this group."),

  joinForbidden: () =>
    new AppError(403, "GROUP_JOIN_FORBIDDEN", "You can't join this group with a link."),

  requestNotFound: () =>
    new AppError(404, "REQUEST_NOT_FOUND", "This join request is no longer pending."),
};
