import type { GroupRole, GroupSettings } from "./groups.policy.js";

// Payload of a 'system' message. Generated only by the server. `names`
// snapshots display names at the time of the event so clients can render
// people they have no other record of.
export type SystemEvent = { names: Record<string, string | null> } & (
  | { kind: "group.created"; actorId: string; name: string; userIds: string[] }
  | { kind: "members.added"; actorId: string; userIds: string[] }
  | { kind: "member.joined"; actorId: string; approvedBy: string | null }
  | { kind: "member.left"; actorId: string }
  | { kind: "member.removed"; actorId: string; userId: string }
  | { kind: "role.changed"; actorId: string; userId: string; role: "admin" | "member" }
  | { kind: "owner.changed"; actorId: string; userId: string }
  | { kind: "info.changed"; actorId: string; name: string | null; descriptionChanged: boolean }
  | { kind: "settings.changed"; actorId: string; changes: Partial<GroupSettings> }
  | { kind: "photo.changed"; actorId: string; removed: boolean }
);

export type SystemEventKind = SystemEvent["kind"];

// Distributes Omit over the union so each variant keeps its own fields.
export type SystemEventInput = SystemEvent extends infer E
  ? E extends SystemEvent
    ? Omit<E, "names">
    : never
  : never;

// What every member sees about the group in the chat list.
export interface GroupInfo {
  name: string;
  description: string | null;
  // The group photo's version, or null for the generated fallback. Members
  // fetch the image through GET /groups/:chatId/photo.
  photoId: string | null;
  memberCount: number;
  myRole: GroupRole;
  settings: GroupSettings;
}

export interface GroupMemberDto {
  userId: string;
  displayName: string | null;
  photoId: string | null;
  available: boolean;
  role: GroupRole;
  joinedAt: string;
}

export interface InviteLinkDto {
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
}

export interface JoinRequestDto {
  userId: string;
  displayName: string | null;
  photoId: string | null;
  createdAt: string;
}

// GET /groups/:chatId. Invite and request data only for admins.
export interface GroupDetails {
  chatId: string;
  name: string;
  description: string | null;
  photoId: string | null;
  createdAt: string;
  createdBy: string;
  myRole: GroupRole;
  settings: GroupSettings;
  memberLimit: number;
  members: GroupMemberDto[];
  invite: InviteLinkDto | null;
  pendingRequests: JoinRequestDto[] | null;
}

// GET /invites/:token. Deliberately excludes the member list.
export interface InvitePreview {
  name: string;
  description: string | null;
  memberCount: number;
  approvalRequired: boolean;
  alreadyMember: boolean;
  chatId: string | null;
}
