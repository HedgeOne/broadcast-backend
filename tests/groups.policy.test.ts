import { describe, expect, it } from "vitest";

import {
  can,
  canActOn,
  type GroupAction,
  type GroupRole,
  type GroupSettings,
  type MemberAction,
} from "../src/modules/groups/groups.policy.js";

const OPEN: GroupSettings = {
  onlyAdminsCanEditInfo: false,
  onlyAdminsCanMessage: false,
  onlyAdminsCanAddMembers: false,
  approvalRequired: false,
  inviteLinksEnabled: true,
  historyVisibleToNewMembers: false,
};

const LOCKED: GroupSettings = {
  ...OPEN,
  onlyAdminsCanEditInfo: true,
  onlyAdminsCanMessage: true,
  onlyAdminsCanAddMembers: true,
};

describe("group policy: group actions", () => {
  const cases: [GroupAction, GroupSettings, Record<GroupRole, boolean>][] = [
    ["view", LOCKED, { member: true, admin: true, owner: true }],
    ["sendMessage", OPEN, { member: true, admin: true, owner: true }],
    ["sendMessage", LOCKED, { member: false, admin: true, owner: true }],
    ["editInfo", OPEN, { member: true, admin: true, owner: true }],
    ["editInfo", LOCKED, { member: false, admin: true, owner: true }],
    ["addMembers", OPEN, { member: true, admin: true, owner: true }],
    ["addMembers", LOCKED, { member: false, admin: true, owner: true }],
    ["changeSettings", OPEN, { member: false, admin: true, owner: true }],
    ["manageInvites", OPEN, { member: false, admin: true, owner: true }],
    ["reviewJoinRequests", OPEN, { member: false, admin: true, owner: true }],
    ["deleteGroup", OPEN, { member: false, admin: false, owner: true }],
  ];

  it.each(cases)("%s with %o", (action, settings, expected) => {
    for (const role of ["member", "admin", "owner"] as const) {
      expect(can(action, role, settings), `${role} ${action}`).toBe(expected[role]);
    }
  });
});

describe("group policy: actions on members", () => {
  // [action, actor, target, allowed]
  const cases: [MemberAction, GroupRole, GroupRole, boolean][] = [
    ["removeMember", "member", "member", false],
    ["removeMember", "admin", "member", true],
    ["removeMember", "admin", "admin", false],
    ["removeMember", "admin", "owner", false],
    ["removeMember", "owner", "admin", true],
    ["removeMember", "owner", "member", true],
    ["deleteMessage", "member", "member", false],
    ["deleteMessage", "admin", "member", true],
    ["deleteMessage", "admin", "admin", false],
    ["deleteMessage", "admin", "owner", false],
    ["deleteMessage", "owner", "admin", true],
    ["promoteToAdmin", "member", "member", false],
    ["promoteToAdmin", "admin", "member", true],
    ["promoteToAdmin", "owner", "member", true],
    ["promoteToAdmin", "owner", "admin", false],
    ["demoteAdmin", "admin", "admin", false],
    ["demoteAdmin", "owner", "admin", true],
    ["demoteAdmin", "owner", "member", false],
    ["transferOwnership", "admin", "member", false],
    ["transferOwnership", "owner", "member", true],
    ["transferOwnership", "owner", "admin", true],
  ];

  it.each(cases)("%s by %s on %s → %s", (action, actor, target, allowed) => {
    expect(canActOn(action, actor, target)).toBe(allowed);
  });
});
