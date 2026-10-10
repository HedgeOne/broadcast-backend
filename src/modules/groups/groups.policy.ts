// The single definition of who may do what in a group. Every group route
// authorizes through `can` against membership state read inside the same
// transaction as the change, so a concurrent role change can't be bypassed.
// The app mirrors this file (broadcast/src/lib/groups/policy.ts) only to
// decide which actions to show.

export const GROUP_ROLES = ["member", "admin", "owner"] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

const RANK: Record<GroupRole, number> = { member: 0, admin: 1, owner: 2 };

export function isAdmin(role: GroupRole): boolean {
  return RANK[role] >= RANK.admin;
}

export function outranks(actor: GroupRole, target: GroupRole): boolean {
  return RANK[actor] > RANK[target];
}

export interface GroupSettings {
  onlyAdminsCanEditInfo: boolean;
  onlyAdminsCanMessage: boolean;
  onlyAdminsCanAddMembers: boolean;
  approvalRequired: boolean;
  inviteLinksEnabled: boolean;
  historyVisibleToNewMembers: boolean;
}

// Actions on the group itself.
export type GroupAction =
  | "view"
  | "sendMessage"
  | "editInfo"
  | "addMembers"
  | "changeSettings"
  | "manageInvites"
  | "reviewJoinRequests"
  | "deleteGroup";

// Actions on another member (or that member's message).
export type MemberAction =
  "removeMember" | "promoteToAdmin" | "demoteAdmin" | "transferOwnership" | "deleteMessage";

export function can(action: GroupAction, role: GroupRole, settings: GroupSettings): boolean {
  switch (action) {
    case "view":
      return true;
    case "sendMessage":
      return !settings.onlyAdminsCanMessage || isAdmin(role);
    case "editInfo":
      return !settings.onlyAdminsCanEditInfo || isAdmin(role);
    case "addMembers":
      return !settings.onlyAdminsCanAddMembers || isAdmin(role);
    case "changeSettings":
    case "manageInvites":
    case "reviewJoinRequests":
      return isAdmin(role);
    case "deleteGroup":
      return role === "owner";
  }
}

// `target` is the other member's current role. Acting on yourself is never
// one of these actions (leaving is separate); callers reject it first.
// A sender who already left counts as a member for message moderation.
export function canActOn(action: MemberAction, actor: GroupRole, target: GroupRole): boolean {
  switch (action) {
    case "removeMember":
    case "deleteMessage":
      return isAdmin(actor) && outranks(actor, target);
    case "promoteToAdmin":
      return isAdmin(actor) && target === "member";
    case "demoteAdmin":
      return actor === "owner" && target === "admin";
    case "transferOwnership":
      return actor === "owner" && target !== "owner";
  }
}
