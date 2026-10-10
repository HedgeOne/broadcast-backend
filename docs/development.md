# Backend development

Requires Node 24 (`nvm use`), pnpm, and Docker (`docker compose up -d`).

## Scripts

| Script                  | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `pnpm dev`              | Run the server with reload (pretty logs).                     |
| `pnpm build` / `start`  | Compile to `dist/` and run the compiled server.               |
| `pnpm typecheck`        | Type-check `src`, `tests` and config files.                   |
| `pnpm lint`             | Type-aware ESLint.                                            |
| `pnpm format[:check]`   | Prettier write / verify.                                      |
| `pnpm test`             | Vitest. Uses `TEST_DATABASE_URL` when set.                    |
| `pnpm db:migrate`       | Apply pending SQL migrations from `migrations/`.              |
| `pnpm db:status`        | List applied and pending migrations.                          |
| `pnpm db:generate`      | Draft SQL for Drizzle schema changes into `drizzle/`.         |
| `pnpm db:check`         | Validate drizzle-kit snapshot consistency.                    |
| `pnpm db:studio`        | Open Drizzle Studio against `DATABASE_URL`.                   |
| `pnpm db:seed`          | Idempotent dev seed: 3 users, 1 direct chat, 1 group, 1 list. |
| `pnpm db:reset --force` | Drop and re-migrate the local database. Local hosts only.     |
| `pnpm db:test:prepare`  | Create `broadcast_test` if missing and migrate it.            |

There is intentionally no `db:push`: every schema change goes through a
reviewed migration file.

## Migrations

`migrations/NNN_name.sql` is the source of truth for database behaviour.
`src/db/migrator.ts` applies pending files in order, records each in
`schema_migrations`, and holds a Postgres advisory lock so concurrent runs are
serialised. Applied migrations are never edited; changes go in a new file.

New migration files must not contain `BEGIN`/`COMMIT` or insert into
`schema_migrations`; the runner wraps each file in a transaction and records
it. (`001_initial.sql` predates the runner and does both itself, which the
runner handles.)

### Changing the schema

1. Edit the Drizzle schema in `src/db/schema/`.
2. `pnpm db:generate --name <change>` writes a draft to `drizzle/`.
3. Review the draft, then copy it to `migrations/NNN_<change>.sql`, adding
   anything Drizzle cannot express (triggers, functions, extensions).
4. `pnpm db:migrate`, then `pnpm db:test:prepare`.
5. Commit the schema change, the migration, and the updated `drizzle/meta`.

`drizzle/0000_baseline_001.sql` is the baseline snapshot of migration 001 as
Drizzle sees it. It exists only so drafts are diffs; never apply files from
`drizzle/` directly.

### What Drizzle does not model

Triggers (`set_updated_at`, `create_default_user_settings`), their functions,
and the `pgcrypto` extension exist only in SQL. `updated_at` columns and the
default `privacy_settings` / `user_settings` rows are maintained by the
database, not application code.

## Tests

`tests/setup.ts` forces `NODE_ENV=test`, points `DATABASE_URL` at
`TEST_DATABASE_URL` and `REDIS_URL` at `TEST_REDIS_URL` (Redis db 1), and sets
placeholder MSG91 credentials and fixed OTP limits. Auth tests inject
`FakeMobileOtpProvider` (`tests/helpers/`) and the MSG91 provider tests stub
`fetch`, so no test ever calls MSG91. Test helpers refuse to truncate unless
the database name ends in `_test` and the Redis db is not 0. Run
`pnpm db:test:prepare` once (and after adding migrations).

## Authentication

Phone number sign-in with an SMS one-time code. The backend talks to MSG91's
SendOTP V5 API; the app never sees a provider credential or request id. MSG91
generates, delivers and checks the code; the backend never stores it. The
backend owns users, devices, sessions and tokens.

1. The app normalises the number to E.164 (libphonenumber-js) and calls
   `POST /auth/phone/start` with `{ phoneNumber }`. The backend re-validates
   it with full metadata (`src/lib/phone.ts`).
2. The backend creates a challenge in Redis bound to that number, asks
   MSG91 to send a code, stores MSG91's `request_id` on the challenge (for
   tracing only) and returns `{ challengeId, codeLength, expiresInSeconds,
resendAvailableInSeconds, resendsRemaining }`. The answer is identical for
   new and existing numbers.
3. `POST /auth/phone/resend` with `{ challengeId }` asks MSG91 to resend the
   **same** code by SMS to the challenge's number, after the resend cooldown
   and within the resend limit.
4. `POST /auth/phone/verify` with `{ challengeId, code, device }` counts the
   attempt and asks MSG91 to verify the code for the challenge's number (never
   a number sent by the client). Only MSG91's documented confirmation
   (`type: "success"`, "OTP verified success") counts.
5. The challenge is deleted (one use only), the user is found or created by
   phone number (`INSERT … ON CONFLICT DO NOTHING` on the unique index, so
   concurrent first sign-ins converge on one row), the device is registered
   and our own access and refresh tokens are issued.

Users exist only after a successful verification; `phone_number` and
`phone_number_verified_at` are both `NOT NULL` (migration 006).

| Route                     | Auth   | Purpose                                                      |
| ------------------------- | ------ | ------------------------------------------------------------ |
| `POST /auth/phone/start`  | –      | Send a code to `{ phoneNumber }`; returns a challenge.       |
| `POST /auth/phone/resend` | –      | Resend the code for `{ challengeId }`.                       |
| `POST /auth/phone/verify` | –      | Exchange `{ challengeId, code, device }` for tokens + user.  |
| `POST /auth/refresh`      | –      | Rotate `{ refreshToken }`; returns a new token pair.         |
| `POST /auth/logout`       | Bearer | Revoke the current session.                                  |
| `POST /auth/logout-all`   | Bearer | Revoke every session for the user.                           |
| `GET /auth/me`            | Bearer | Current user (including their own `phoneNumber`) and device. |
| `PATCH /users/me`         | Bearer | Update `{ displayName?, dateOfBirth? }`; returns user.       |

`PATCH /users/me` powers onboarding. `displayName` is trimmed, 1–50
characters; `dateOfBirth` is `YYYY-MM-DD` and the user must be at least 16
(measured against today's UTC date). The app treats a user without both
fields as still needing onboarding.

Errors are always `{ "error": { "code", "message", "details?" } }`. Phone
sign-in can fail with:

| Code                       | Status  | Meaning                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------ |
| `VALIDATION_ERROR`         | 400     | Invalid phone number, code format, challenge id or device.               |
| `INVALID_CODE`             | 400     | Wrong code; `details.attemptsRemaining` > 0.                             |
| `CODE_EXPIRED`             | 410     | Challenge expired, used, or out of attempts. Request a new code.         |
| `RATE_LIMITED`             | 429     | IP/number limit, send cooldown or MSG91 throttling; `retryAfterSeconds`. |
| `RESEND_LIMIT_REACHED`     | 429     | No resends left for this challenge.                                      |
| `VERIFICATION_UNAVAILABLE` | 502/503 | MSG91 unreachable, misconfigured or unclear (502), or Redis down (503).  |
| `ACCOUNT_UNAVAILABLE`      | 403     | The account is disabled or deleted.                                      |

- **Challenges** (`src/modules/auth/otp/challenge-store.ts`) live in Redis
  under an unguessable 256-bit id with a TTL (`AUTH_OTP_TTL_SECONDS`). Attempt
  counting, resend cooldown/limits and one-time consumption are atomic Lua
  scripts, so concurrent requests cannot exceed limits or mint two sessions.
- **Redis outages:** the rate limiter fails open, but challenges fail closed —
  start, resend and verify return 503 and no SMS is sent, because the
  challenge is written before MSG91 is called.
- **Rate limits** (`AUTH_OTP_*`, fixed windows): sends (start + resend) per IP
  and per number, verifies per IP and per number (bounding guesses across
  challenges), plus a per-number send cooldown and per-challenge attempt and
  resend limits.
- **Access tokens** are HS256 JWTs (`sub`, `sid`, `did` only) valid for
  `AUTH_ACCESS_TOKEN_TTL_SECONDS`. The `authenticate` hook also checks the
  session is still active, so logout takes effect immediately.
- **Refresh tokens** are `<sessionId>.<secret>`; only a SHA-256 of the secret
  is stored. Every refresh rotates the token, and presenting an already-rotated
  token revokes the session.
- **Logging:** provider failure kinds and scrubbed MSG91 reasons are logged;
  OTPs, phone numbers, challenge ids, MSG91 request ids, access tokens,
  refresh tokens and MSG91 credentials never are.

### MSG91 setup

The backend uses MSG91's classic SendOTP V5 API
([docs](https://docs.msg91.com/otp)). `mobile` is the E.164 number without
`+`; `authkey` is sent as a header on every call.

| Call                     | Parameters (query)                                                                                    | Success                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/v5/otp`       | `template_id, mobile, otp_length, otp_expiry` (minutes), `invisible=0, realTimeResponse=1`; body `{}` | `{ type: "success", request_id }`                      |
| `GET /api/v5/otp/retry`  | `mobile, retrytype=text, authkey` (documented as a query parameter here)                              | `{ type: "success", message }`                         |
| `GET /api/v5/otp/verify` | `mobile, otp`                                                                                         | `{ type: "success", message: "OTP verified success" }` |

MSG91 returns most failures as HTTP 200 with `{ type: "error", message,
code? }`, so success is decided from the body, never the status. Known
messages map to provider error kinds ("OTP not match" → wrong code, "OTP
expired" / "No OTP request found" / "already verified" → expired, "OTP retry
count maxed out" → exhausted, "Invalid authkey" (code 201) or an invalid
template → misconfigured). Anything unrecognised fails closed as
`unavailable` (502).

MSG91 keys the code by mobile number: a new send replaces the previous code,
a resend re-delivers the same code, and MSG91 allows at most 2 retries — keep
`AUTH_OTP_MAX_RESENDS` at 2 or below.

- **Auth key:** MSG91 → profile → Authkey → `MSG91_AUTH_KEY`. New auth keys
  have API security (IP whitelisting) on by default: whitelist the server's
  public IPs — both IPv4 and IPv6 if the network has IPv6 — or turn API
  security off for local development. A wrong key is reported as code `201`;
  the backend logs the reason and returns 502 `VERIFICATION_UNAVAILABLE`.
- **OTP template:** MSG91 → OTP → Templates. Use an approved template whose
  text contains `##OTP##`, linked to your approved sender ID and, for Indian
  numbers, its DLT template ID (see MSG91's
  [DLT mapping guide](https://msg91.com/help/dlt-registration-in-india/map-sms-content-template-on-msg91-api-panel)).
  Copy its ID into `MSG91_OTP_TEMPLATE_ID`. The code length and expiry come
  from `AUTH_OTP_CODE_LENGTH` and `AUTH_OTP_TTL_SECONDS` (whole minutes).

#### Live test (manual, real SMS)

Automated tests never call MSG91. To check delivery with a phone you control,
start the API with real credentials (`pnpm dev`) and the app, then:

1. Enter your number on the sign-in screen (or
   `curl -X POST localhost:3000/auth/phone/start -H 'content-type: application/json' -d '{"phoneNumber":"+91…"}'`)
   and expect HTTP 200 with a `challengeId`; the API logs `phone otp sent`.
2. Confirm the SMS arrives from your sender ID with the approved template
   text. If not, check MSG91 → OTP → Logs/Reports for DLT errors (e.g. 211,
   203).
3. Enter a wrong code: expect "That code is incorrect" (`INVALID_CODE`).
4. Enter the right code: expect sign-in (`/auth/phone/verify` 200 with
   tokens); a new number lands on onboarding, an existing one on Chats.
5. Start again, wait out the cooldown, tap "Resend code": the same code
   arrives again by SMS. After `AUTH_OTP_TTL_SECONDS`, the code is refused
   (`CODE_EXPIRED`).
6. Check `GET /auth/me` with the access token returns your E.164 number.

The provider sits behind `MobileOtpProvider`
(`src/modules/auth/otp/mobile-otp-provider.ts`); `Msg91MobileOtpProvider` is
the only implementation.

## Direct messaging

Postgres is the source of truth; the WebSocket only tells clients that
something changed. Clients store messages in an on-device SQLite cache and
resync over REST after every (re)connect.

| Route                                                | Purpose                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /chats`                                         | Chat summaries with at least one message, newest first.                                                           |
| `POST /chats/direct`                                 | Open (or create) the direct chat with `{ userId }`. Idempotent per pair of users.                                 |
| `GET /chats/:chatId`                                 | One chat summary (members only).                                                                                  |
| `PUT /chats/:chatId/mute`                            | `{ muted }`.                                                                                                      |
| `POST /chats/:chatId/receipts`                       | Advance `{ deliveredSequence?, readSequence? }` for the caller.                                                   |
| `GET /chats/:chatId/messages`                        | `?after=` (ascending, for sync) or `?before=` / latest (paging back); `limit` 1–100.                              |
| `POST /chats/:chatId/messages`                       | `{ clientMessageId, type: "text", ciphertext, replyToMessageId?, mentions? }` → 201 created, 200 for a retry.     |
| `DELETE /chats/:chatId/messages/:messageId`          | Delete for everyone; leaves a tombstone. Idempotent.                                                              |
| `PUT /chats/:chatId/messages/:messageId/reaction`    | `{ emoji }` (one of 👍 ❤️ 😂 😮 😢 🙏); one reaction per person.                                                  |
| `DELETE /chats/:chatId/messages/:messageId/reaction` | Remove your reaction.                                                                                             |
| `POST /contacts/match`                               | `{ phoneNumbers }` (E.164, ≤ `CONTACTS_MATCH_MAX_BATCH`) → `{ matches }`. See below.                              |
| `GET /users/:userId`                                 | Public profile (`displayName`, `available`, `blockedByMe`); never the phone number.                               |
| `PUT /privacy/blocks/:userId`                        | Block (idempotent, 204).                                                                                          |
| `DELETE /privacy/blocks/:userId`                     | Unblock (204).                                                                                                    |
| `POST /privacy/reports`                              | `{ userId?, chatId?, messageId?, reason, block }` → `{ reported, blocked }`. A message report targets its sender. |

All routes need a Bearer token.

- **Ordering:** each message gets the next per-chat `sequence` inside a
  transaction that locks the chat row; `sequence` is the only order clients
  use.
- **Idempotency:** `(sender device, clientMessageId)` is unique. Resending
  the same message returns the stored copy (200) instead of a duplicate.
- **Receipts:** per-member `delivered_sequence` / `read_sequence` pointers
  that only move forward, are capped at the chat's latest sequence, and keep
  read ≤ delivered. Read pointers are shared only when both users have
  `show_read_receipts` on; otherwise the peer sees `peerReadSequence: null`.
- **Blocking:** `BLOCKED` (403) when you blocked them. When they blocked you
  (or their account is inactive) the error is `RECIPIENT_UNAVAILABLE`, so a
  block is never revealed. Contact matching hides users in either direction.
- **Bodies** are opaque base64 (`ciphertext`, ≤ 48 KiB). Today the app sends
  UTF-8 text; end-to-end encryption can replace the encoding without API
  changes.
- **Rate limits:** sending 120/min per user, reactions 120/min, deletions
  60/min, reports 20/day. Contact matching limits are below.
- **Replies** must point at a visible, non-deleted, non-system message in
  the same chat. `replyTo.available` is false when the quoted message was
  deleted or predates the reader's membership.
- **Deletion:** senders delete their own messages; in groups, admins delete
  messages from people they outrank. The row keeps its sequence with an
  empty body, and its reactions and mentions are removed.

## Groups

A group is a `chats` row (`type = 'group'`) plus a `groups` row. Membership
and roles live in `chat_members` (`left_at` null = active; `removed_by` set
= removed by an admin). The central policy is
`src/modules/groups/groups.policy.ts`; every mutation runs in one
transaction holding the chat row lock (`SELECT … FOR UPDATE`) and
authorizes against membership re-read inside it. Sending a message takes
the same lock, so a removal or "only admins can send" change that commits
first always wins.

| Route                                                      | Purpose                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /groups`                                             | `{ clientRequestId, name, description?, memberIds }` → `{ chat }`; 201, or 200 for a retry. |
| `GET /groups/:chatId`                                      | Details: members, settings, `myRole`; invite + pending requests for admins only.            |
| `PATCH /groups/:chatId`                                    | `{ name?, description? }` (empty description clears it).                                    |
| `PATCH /groups/:chatId/settings`                           | Any of the six settings below.                                                              |
| `DELETE /groups/:chatId`                                   | Owner only. Soft delete; every membership ends.                                             |
| `POST /groups/:chatId/members`                             | `{ userIds }`; all-or-nothing.                                                              |
| `DELETE /groups/:chatId/members/:userId`                   | Remove a member you outrank.                                                                |
| `PUT /groups/:chatId/members/:userId/role`                 | `{ role: "admin" \| "member" }`.                                                            |
| `POST /groups/:chatId/owner`                               | `{ userId }`: transfer ownership (you become an admin).                                     |
| `POST /groups/:chatId/leave`                               | `{ newOwnerId? }` → 204.                                                                    |
| `POST /groups/:chatId/invite`                              | `{ expiresInHours?, maxUses? }` → `{ token, invite }` (token shown once).                   |
| `DELETE /groups/:chatId/invite`                            | Revoke the active link.                                                                     |
| `POST /groups/:chatId/requests/:userId/approve` / `reject` | Decide a join request.                                                                      |
| `GET /invites/:token`                                      | Preview: name, description, member count, approval; never members.                          |
| `POST /invites/:token/join`                                | → `{ status: "joined", chatId }` or `{ status: "pending" }`.                                |

Permissions (O = owner, A = admin, M = member):

| Action                                                    | Allowed                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| View, read, react, leave, report                          | O A M                                                            |
| Send messages                                             | O A M, or O A when `onlyAdminsCanMessage`                        |
| Edit name/description                                     | O A M, or O A when `onlyAdminsCanEditInfo`                       |
| Add members                                               | O A, or O A M when `onlyAdminsCanAddMembers` is off (default on) |
| Change settings, manage invite link, review join requests | O A                                                              |
| Remove member / delete their messages                     | Anyone who outranks the target (A → M, O → A, M)                 |
| Promote member to admin                                   | O A                                                              |
| Demote admin                                              | O                                                                |
| Transfer ownership, delete group                          | O                                                                |

- **Settings** (defaults): `onlyAdminsCanEditInfo` (off),
  `onlyAdminsCanMessage` (off), `onlyAdminsCanAddMembers` (on),
  `approvalRequired` (off), `inviteLinksEnabled` (off; turning it off
  revokes the link), `historyVisibleToNewMembers` (off).
- **Creation** is idempotent per `(creator, clientRequestId)` (unique
  index) and atomic: chat, group, memberships and the "created" event
  commit together or not at all.
- **Participants** who are inactive, blocked you, or turned off
  `allow_group_invites` fail as `PARTICIPANTS_UNAVAILABLE` (one code, so a
  block is never revealed); people you blocked fail as
  `PARTICIPANTS_BLOCKED`. Size is capped by `GROUP_MAX_MEMBERS` (default
  256, including the owner).
- **Ownership:** exactly one owner (partial unique index). An owner who
  leaves hands over to `newOwnerId`, else the longest-standing admin, else
  the longest-standing member. The last member leaving deletes the group.
- **History for new members:** with history hidden, a new member's
  `history_from_sequence` is the latest sequence when they join; lists,
  summaries, replies and reports never reach below it. Either way, nothing
  before joining counts as unread.
- **System events** (`type = 'system'`, `system_event` JSON with `kind`,
  actor, target ids and display-name snapshots) are written only by the
  server, in the same transaction as the change, and form the audit trail.
  Clients can't send `type: "system"` (400).
- **Mentions:** the body carries `@{userId}` tokens and `mentions` lists
  the ids; every id must be an active member (`INVALID_MENTIONS`).
  Mentions are rejected in direct chats.
- **Invite links:** 32 random bytes (base64url); only the SHA-256 is
  stored. One active link per group; creating a new one revokes the old.
  Unknown, revoked, expired and used-up links are all `INVITE_INVALID`
  (404). People an admin removed can't rejoin through a link
  (`GROUP_JOIN_FORBIDDEN`); people who left can. With approval on, joining
  files a request instead (one pending request per person).
- **Receipts:** a sender's ticks use the lowest delivered/read pointer of
  the other active members (`peerDeliveredSequence` / `peerReadSequence`
  in the summary, `receipts.aggregate` live).
- **Not implemented:** group photos (no media storage yet; groups show
  initials), push notifications (mute is stored but there is nothing to
  silence yet), and public https invite links (the app shares
  `broadcast://join/<token>`). Bodies are not end-to-end encrypted.

### Contact matching

`POST /contacts/match` with `{ "phoneNumbers": ["+919876543210", ...] }`
returns `{ "matches": [{ "phoneNumber", "user": { id, displayName,
available, blockedByMe } }] }`, sorted by number.

- **Input:** the app reads the address book on the device, normalises
  numbers to E.164 with `libphonenumber-js` (using the country of the
  user's own number), drops invalid and duplicate numbers and the user's
  own number, and sends only the numbers, in chunks. Names and other
  contact fields never leave the device. The server rejects anything that
  is not canonical E.164 for a valid number (400) and dedupes the rest.
- **When the app checks:** at session start, when the app returns to the
  foreground, when New chat opens and when Chats search is focused. An
  unchanged address book reuses the last result for 5 minutes (pull to
  refresh in New chat always re-checks). Nobody is told when a contact
  joins, because the server keeps no address books, so this re-check is
  how new users show up. The default limits (60 requests and 20 000
  numbers per user per hour) leave room for that.
- **Matching:** one query, `phone_number = ANY($1::text[])` on
  `users_phone_number_unique`, inside a transaction with a local
  `statement_timeout` (`CONTACTS_MATCH_QUERY_TIMEOUT_MS`; a timeout is a
  503 `CONTACTS_UNAVAILABLE`). Only active users other than the caller,
  with no block in either direction, are returned. Every other case,
  including unregistered numbers, is simply absent from `matches`, so the
  response never says why a number did not match.
- **No persistence:** nothing about the request is written to Postgres, and
  the body is never logged. Redis holds only the rate-limit counters, keyed
  by user id and a hash of the client IP.
- **Limits** (fixed windows of `CONTACTS_MATCH_WINDOW_SECONDS`): requests per
  user and per IP, plus a budget of distinct numbers looked up per user
  (`CONTACTS_MATCH_USER_NUMBER_LIMIT`). Exceeding any of them is 429
  `RATE_LIMITED` with `details.retryAfterSeconds`.
- **What this does not protect against:** the server necessarily sees the
  numbers it matches. Hashing numbers before upload would not change that,
  because the phone number space is small enough to reverse unsalted
  hashes by brute force, so the API does not pretend otherwise; the rate
  limits are what bound enumeration. Migration 007 removed the old hashed
  lookup column.

### Realtime

`GET /ws` upgrades to a WebSocket authenticated by the
`Authorization: Bearer` header (same access token and session check as
REST). Events are JSON:

- `connection.ready` — sent once after connecting.
- `message.new` — `{ chatId, message }`, to every member, including the
  sender's other devices.
- `message.deleted` — `{ chatId, message }` with the tombstone.
- `reaction.updated` — `{ chatId, messageId, userId, emoji }` (`emoji` null
  when removed).
- `receipt.updated` — `{ chatId, userId, deliveredSequence, readSequence }`
  (`readSequence` is null for the peer when read receipts are hidden). In
  groups only the reader's own devices get this.
- `receipts.aggregate` — `{ chatId, deliveredSequence, readSequence }`,
  to group members when the slowest member's pointer moves.
- `chat.updated` — `{ chatId }`: group info, settings, roles or members
  changed; refetch the summary/details.
- `chat.removed` — `{ chatId }`: you left, were removed, or the group was
  deleted.
- `pong` — reply to a client `{ "type": "ping" }`.

Group events go only to members who are active when the change commits,
so removed members stop receiving anything immediately. Every event is
published after its transaction commits. There is no separate outbox:
Postgres is the record, and clients resync over REST on connect, on
foreground and when opening a chat, so a hint lost to a failed Redis
publish is picked up on the next sync rather than lost.

Events fan out through Redis (`rt:user:<id>` channels) so any API instance
can deliver them; if Redis is down, events still reach sockets on the same
instance. The server pings every 30 s and drops sockets that stop
answering. Sockets aren't closed when a session is revoked; they fail
authentication on the next reconnect.

## API documentation

Not generated yet. Request schemas are Zod (`src/modules/*/*.schemas.ts`) so
OpenAPI can later be derived from them.
