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
| `pnpm media:check`      | Round-trip test of the real S3 bucket (see Media).            |
| `pnpm media:reconcile`  | Media cleanup pass plus orphan report (`--delete` removes).   |

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

| Route                                                | Purpose                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /chats`                                         | Chat summaries with at least one message, newest first.                                                                               |
| `POST /chats/direct`                                 | Open (or create) the direct chat with `{ userId }`. Idempotent per pair of users.                                                     |
| `GET /chats/:chatId`                                 | One chat summary (members only).                                                                                                      |
| `PUT /chats/:chatId/mute`                            | `{ muted: true, duration?: "8h" \| "1w" \| "always" }` or `{ muted: false }`. See Push notifications.                                 |
| `POST /chats/:chatId/receipts`                       | Advance `{ deliveredSequence?, readSequence? }` for the caller.                                                                       |
| `GET /chats/:chatId/messages`                        | `?after=` (ascending, for sync) or `?before=` / latest (paging back); `limit` 1–100.                                                  |
| `POST /chats/:chatId/messages`                       | `{ clientMessageId, type, ciphertext, attachment?, replyToMessageId?, mentions? }` → 201 created, 200 for a retry (media: see Media). |
| `DELETE /chats/:chatId/messages/:messageId`          | Delete for everyone; leaves a tombstone. Idempotent.                                                                                  |
| `PUT /chats/:chatId/messages/:messageId/reaction`    | `{ emoji }` (one of 👍 ❤️ 😂 😮 😢 🙏); one reaction per person.                                                                      |
| `DELETE /chats/:chatId/messages/:messageId/reaction` | Remove your reaction.                                                                                                                 |
| `POST /contacts/match`                               | `{ phoneNumbers }` (E.164, ≤ `CONTACTS_MATCH_MAX_BATCH`) → `{ matches }`. See below.                                                  |
| `GET /users/:userId`                                 | Public profile (`displayName`, `available`, `blockedByMe`); never the phone number.                                                   |
| `PUT /privacy/blocks/:userId`                        | Block (idempotent, 204).                                                                                                              |
| `DELETE /privacy/blocks/:userId`                     | Unblock (204).                                                                                                                        |
| `POST /privacy/reports`                              | `{ userId?, chatId?, messageId?, reason, block }` → `{ reported, blocked }`. A message report targets its sender.                     |

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
- **Not implemented:** public https invite links (the app shares
  `broadcast://join/<token>`). Bodies are not end-to-end encrypted.

## Broadcast lists

A broadcast list is a saved set of recipients that only its owner can see
or use. It is **not** a conversation: sending to a list writes one
ordinary direct message per recipient, in the recipient's existing direct
chat with the owner (created idempotently if there is none). Recipients
see a normal message from the owner — never the list, its name or the
other recipients — and replies are ordinary direct messages.

| Route                                                  | Purpose                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET /broadcasts`                                      | The caller's lists, most recent activity first, each with its last broadcast.      |
| `POST /broadcasts`                                     | `{ clientRequestId, name, recipientIds }` → `{ list }`; 201, or 200 for a retry.   |
| `GET /broadcasts/:listId`                              | List plus current recipients and `maxRecipients`.                                  |
| `PATCH /broadcasts/:listId`                            | `{ name?, muted? }`.                                                               |
| `DELETE /broadcasts/:listId`                           | Soft delete → 204.                                                                 |
| `POST /broadcasts/:listId/recipients`                  | `{ recipientIds }`; existing recipients are ignored.                               |
| `DELETE /broadcasts/:listId/recipients/:userId`        | Remove from future broadcasts.                                                     |
| `GET /broadcasts/:listId/messages`                     | History, oldest first; `?before=<broadcastId>&limit=` pages back.                  |
| `POST /broadcasts/:listId/messages`                    | `{ clientMessageId, type, ciphertext, attachment? }` → `{ broadcast }`; 201 / 200. |
| `GET /broadcasts/:listId/messages/:broadcastId`        | `{ broadcast, recipients }`: the per-recipient report.                             |
| `POST /broadcasts/:listId/messages/:broadcastId/retry` | Re-send to retryable failures only → `{ broadcast }`.                              |

- **Ownership:** every route is scoped to the authenticated owner. Other
  people's lists, deleted lists and unknown ids are all
  `BROADCAST_LIST_NOT_FOUND` (404). Owner, sender and status are never
  read from the request (unknown fields on send/update are a 400).
- **Recipients** must be active accounts with no block either way, the
  same rule as starting a direct chat. Inactive accounts and people who
  blocked you fail as `RECIPIENTS_UNAVAILABLE` (one code, so a block is
  never revealed); people you blocked fail as `RECIPIENTS_BLOCKED`. The
  server has no address book, so "saved in my contacts" is not part of
  eligibility. Size is capped by `BROADCAST_MAX_RECIPIENTS` (default 256);
  there is no limit on how many lists a user has.
- **Creation** is idempotent per `(owner, clientRequestId)` and atomic.
- **Sending** happens in two steps:
  1. _Accept_ (one transaction, holding the list row lock that renames,
     membership changes and deletion also take): idempotency check on
     `(sender, clientMessageId)`, then a `broadcast_messages` row and one
     `broadcast_message_recipients` row per current recipient — the
     snapshot that later edits can't change. Recipients who can't be
     messaged right now are recorded as failed immediately.
  2. _Deliver_ each pending recipient in its own transaction: lock the
     recipient row (`FOR UPDATE SKIP LOCKED`, must still be `pending`),
     find or create the direct chat, take the chat lock, insert the
     message with the next sequence, and record `message_id`,
     `target_chat_id` and `sent` — all in one commit, so a recipient can
     never get two messages from one broadcast. Then `message.new` goes
     to the recipient and the owner as for any direct message.
     The request runs both steps (in batches of 32, four chats at a time)
     and returns the outcome. If the process dies in between, recipients
     stay `pending` in Postgres and the dispatcher's sweep
     (`BROADCAST_SWEEP_INTERVAL_MS`, and once at startup) delivers them.
- **Recipient status:** `pending` (accepted, not yet written) → `sent`
  (direct message committed) → `delivered` → `read`, or `failed` with a
  `failure_code` and `retryable`. Status never moves backwards.
  `delivered` / `read` come from the recipient's ordinary receipt pointers
  in that direct chat (`POST /chats/:chatId/receipts`): when they advance,
  every recipient record whose message they now cover moves forward. Read
  state is only reported while both people allow read receipts (otherwise
  it shows as delivered), exactly like direct-chat ticks.
- **Failures:** `RECIPIENT_UNAVAILABLE` (inactive or blocked you;
  permanent), `BLOCKED` (you blocked them; retryable after unblocking),
  `DELIVERY_FAILED` (an error writing the message; retryable, until 5
  attempts). A broadcast can be partly delivered; successful deliveries
  are kept. Retry re-queues only retryable failures.
- **Summary:** each broadcast carries cumulative counts computed from its
  recipient records — `total`, `pending`, `accepted` (sent or later),
  `delivered` (delivered or read), `read`, `failed`, `retryable` — and a
  `state`: `sending`, `completed`, `partial` or `failed`.
- **Body storage:** the direct messages are the authoritative copies.
  `broadcast_messages.ciphertext` holds the body only while a recipient is
  pending or retryable and no direct message carries it yet, then it is
  cleared; history reads the owner's own copy from a delivered message.
- **Deletion** soft-deletes the list: it disappears from every route, but
  direct messages already sent and the recipient records stay. A send
  either commits its snapshot before the delete (and is delivered in
  full) or sees the list as gone.
- **Mute** is stored per list for the owner's own organisation. The owner
  is never notified about their own broadcasts, so it silences nothing.
  Recipients are notified once per broadcast, like any direct message (see
  Push notifications), and can mute their direct chat with the owner.
- **Limits:** 30 list creations, 300 edits, 60 sends and 60 retries per
  user per hour.
- **Logging:** delivery errors log the broadcast id and error only — never
  bodies, phone numbers or recipient lists.

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
- `broadcast.updated` — `{ listId, reason, broadcast }` to the list
  owner's devices only. `reason` is `accepted`, `progress`, `completed`,
  `delivered`, `read` or `retry`; `broadcast` carries the current summary.
- `broadcast.list.updated` / `broadcast.list.deleted` — `{ listId }` to
  the owner: refetch, or drop the list.
- `broadcast.list.cleared` — `{ listId }` to the owner: reload the list's
  history.
- `chat.cleared` — `{ chatId, clearedThroughSequence }` to the caller's own
  devices only: drop cached messages at or below the sequence.
- `message.starred` — `{ chatId, messageId, starred }` to the caller's own
  devices only.
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

## Media

Photos, videos, audio and documents (up to **15 MB**) are stored in the
private S3 bucket `AWS_S3_BUCKET` (`holler-media-prod-998`, `ap-south-1`).
File bytes never pass through the API server: the app uploads and
downloads directly with short-lived presigned URLs that the server issues
after checking permissions. AWS credentials stay on the server (the AWS
SDK's default provider chain: `.env` locally, an IAM role in
production); nothing AWS-related is ever sent to or built into the app.

| Route                                      | Purpose                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /media/uploads`                      | `{ clientUploadId, category, mimeType, fileName?, fileSize, width?, height?, durationMs? }` → `{ upload, target }`; 201, or 200 for a retry (`target` null once ready). |
| `GET /media/uploads/:uploadId`             | The caller's upload.                                                                                                                                                    |
| `POST /media/uploads/:uploadId/complete`   | Verify the stored object → `{ upload }` with `status: "ready"`. Idempotent.                                                                                             |
| `DELETE /media/uploads/:uploadId`          | Discard an upload no message uses yet → 204 (`UPLOAD_IN_USE` once sent).                                                                                                |
| `GET /media/uploads/:uploadId/url`         | Owner-only download URL for their verified upload (broadcast history).                                                                                                  |
| `GET /media/attachments/:attachmentId/url` | `?variant=original\|thumbnail` → `{ url, expiresAt }` for a chat member.                                                                                                |

**Flow.** The app opens a session, `PUT`s the bytes to `target.url` with
`target.headers`, calls `complete`, then sends a message:
`POST /chats/:chatId/messages` (or `/broadcasts/:listId/messages`) with
`type` `image` / `video` / `audio` / `document`, `ciphertext` = the caption
(may be empty) and `attachment: { uploadId, thumbnailUploadId? }`. One
attachment per message (an album is several messages). Video posters are
uploaded the same way as small JPEG/PNG/WebP images (≤ 1 MB).

- **Keys** are generated by the server: `attachments/{128-bit random hex}/original`.
  They never contain user, chat or phone identifiers or file names, and are
  never returned by the API.
- **Upload URL** (`MEDIA_UPLOAD_URL_TTL_SECONDS`, default 15 min) signs
  `Content-Type` and `Content-Length`, so S3 itself refuses a body of any
  other size or type. No ACL is set; objects stay private.
- **Validation** at session creation: category ↔ MIME allowlist
  (`src/modules/media/media.policy.ts`; executables, scripts, HTML, SVG,
  APKs, installers and anything unlisted are refused), the file name's
  extension must belong to the type (documents must have one), names are
  stripped of directories and control characters and capped at 255
  characters, and the declared size must be ≤ `MEDIA_MAX_FILE_BYTES`
  (15 MB; the config refuses a larger value).
- **Completion** HEADs the object and requires the exact declared size, the
  declared type, and file-signature bytes (first 64 bytes, ranged GET)
  matching the type. A refused object is deleted and the upload is
  `failed` with `UPLOAD_REJECTED` (`details.reason`: `SIZE_MISMATCH`,
  `TYPE_MISMATCH`, `CONTENT_MISMATCH`, `TOO_LARGE`). Not uploaded yet →
  `UPLOAD_INCOMPLETE` (409); session expired → `UPLOAD_EXPIRED` (410).
- **Sending** locks the upload row inside the message transaction and
  requires: the sender owns it, it is `ready`, and its category equals the
  message type (`ATTACHMENT_INVALID` otherwise). The attachment row is
  written in `message_attachments` (the only attachment table) with the
  verified metadata and `upload_id`.
- **Broadcasts** upload once. `broadcast_messages.attachment_upload_id`
  holds the shared upload; each recipient's direct message gets its own
  `message_attachments` row pointing at the same object, and access is
  always authorized through that recipient's own message.
- **Downloads** (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`, default 5 min) are
  authorized through the message: the caller must currently be a member of
  the chat, the message must be inside their visible history (group
  members who joined later can't fetch older files; removed members can't
  fetch anything), and the message must not be deleted. Every refusal is
  `MEDIA_NOT_FOUND` (404). URLs force `Content-Disposition: attachment`
  and `Cache-Control: private`, and responses are `no-store`. When a URL
  expires the app simply asks for a new one.
- **Events and lists** never contain URLs: `message.new` carries
  `attachment` metadata (`id`, `type`, `mimeType`, `fileName`, `fileSize`,
  `width`, `height`, `durationMs`, `hasThumbnail`). Chat list previews
  carry only the message `type`; the app shows "Photo", "Video", "Audio"
  or "Document".
- **Deletion:** deleting a message for everyone removes its attachment
  row. The S3 object is deleted once no message and no pending/retryable
  broadcast recipient references the upload.
- **Cleanup** (`MediaSweeper`, every `MEDIA_SWEEP_INTERVAL_MS`): sessions
  never completed (1 h after their URL expired), uploads never sent within
  `MEDIA_UNATTACHED_TTL_SECONDS` (default 24 h), and uploads no longer
  referenced are marked `deleted` under row locks (re-checked after
  locking, so a concurrent send wins), then their objects are removed;
  failed S3 deletes are retried on the next run. Objects deleted while
  their upload URL still worked are deleted again after it expires.
  Thumbnails are uploads too, so orphaned posters follow the same rules.
- **Orphan reconciliation:** `pnpm media:reconcile` runs one cleanup pass
  and reports objects under `attachments/` and the photo prefixes that no
  live upload owns (older
  than a day); `--delete` removes them. Listing needs `s3:ListBucket`.
- **Rate limits:** session creation 30/min and 300/h, completion 120/min,
  download URLs 600/h per user.
- **Encryption:** attachments are protected in transit by HTTPS and at rest
  by S3 server-side encryption. That is **not** end-to-end encryption:
  the server operator can read the files. The design leaves room for E2EE:
  the client would encrypt each file with a random key before upload
  (uploads would be declared as opaque ciphertext, with type and signature
  checks moving to the client), put the key and real metadata in the
  encrypted message body, and keep `message_attachments.encryption_metadata`
  for per-file parameters. Keys, access control and cleanup would not
  change.

**AWS setup.** Keep Block Public Access fully on and ACLs disabled
(bucket-owner enforced). The server's credentials need `s3:PutObject`,
`s3:GetObject` and `s3:DeleteObject` on `attachments/*`, `profile-photos/*`,
`group-photos/*` and `broadcast-list-photos/*` (plus `s3:ListBucket` for
reconciliation). The app doesn't use multipart uploads
(15 MB fits one PUT), but add a lifecycle rule "abort incomplete multipart
uploads after 1 day" as a safeguard. Default S3 encryption (SSE-S3) is
enough; versioning would keep deleted objects, so leave it off or add a
rule that expires noncurrent versions. Browser uploads would also need a
bucket CORS rule; the mobile app does not.

`pnpm media:check` tests the real bucket with the server's credentials: a
presigned PUT round trip, refusal of a different size or type, a presigned
GET, refusal of an unsigned GET (objects aren't public), and deletion. It
prints outcomes only, never URLs or credentials.

## Photos

Users, groups and broadcast lists can have a photo. Photos use the media
pipeline above with a `purpose` on the upload session, and are never
message attachments.

| Route                                      | Purpose                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `POST /media/uploads`                      | Add `purpose`: `profile_photo`, `group_photo` or `broadcast_list_photo` (default `attachment`). |
| `PUT /users/me/photo`                      | `{ uploadId, thumbnailUploadId }` → `{ user }` (`user.photoId` set).                            |
| `DELETE /users/me/photo`                   | → `{ user }` with `photoId: null`. Idempotent.                                                  |
| `GET /users/:userId/photo`                 | `?variant=thumbnail\|original` (default thumbnail) → `{ url, expiresAt }`.                      |
| `POST /groups`                             | Optional `photo: { uploadId, thumbnailUploadId }`.                                              |
| `PUT` / `DELETE /groups/:chatId/photo`     | Set / remove → `{ group }`. Needs the `editInfo` permission.                                    |
| `GET /groups/:chatId/photo`                | Download URL for current members.                                                               |
| `POST /broadcasts`                         | Optional `photo`.                                                                               |
| `PUT` / `DELETE /broadcasts/:listId/photo` | Set / remove → `{ list }`. Owner only.                                                          |
| `GET /broadcasts/:listId/photo`            | Download URL for the owner.                                                                     |
| `GET` / `PATCH /privacy/settings`          | `{ profilePhotoVisibility: "everyone" \| "nobody" }`.                                           |

**Flow.** The app crops the image to a square on the device and makes two
JPEGs (about 1024 px and 256 px), uploads both with the photo's purpose,
completes them, then sets the photo. Nothing changes until that last call
succeeds, so a failed upload keeps the old photo.

- **Uploads:** photos are JPEG, PNG or WebP only, up to 5 MB, verified
  like any upload (exact size, type and file signature). The thumbnail
  must be ≤ 1 MB. Keys are `profile-photos/…`, `group-photos/…` or
  `broadcast-list-photos/…` + `{128-bit random hex}/original`.
- **Setting** locks both uploads and requires: the caller owns them,
  they're `ready`, made for that purpose, and never used before
  (`PHOTO_INVALID`, 422, otherwise). Setting the current photo again is a
  no-op, so retries are safe; concurrent changes are serialized by the
  user, group or list row lock. A group or list created with an unusable
  photo isn't created at all.
- **Storage:** `users`, `groups` and `broadcast_lists` hold
  `photo_upload_id` and `photo_thumbnail_upload_id` (both or neither,
  `ON DELETE RESTRICT`). Rows store upload references, never URLs. DTOs
  carry `photoId` (the current upload id, a cache key) or `null`.
- **Who sees a profile photo:** the owner always; anyone else only while
  the account is active, the owner's `profile_photo_visibility` is
  `everyone`, and neither has blocked the other. The same SQL rule
  (`src/modules/photos/photos.access.ts`) sets `photoId` in every
  response (chat list, profiles, group members and join requests, list
  recipients and reports, contact matches) and authorizes
  `GET /users/:userId/photo`. Refusals are `PHOTO_NOT_FOUND` (404), the
  same as "no photo".
- **"My contacts" is not offered.** The server has no trustworthy contact
  relationships: contact matching is stateless and address books are
  never stored. Supporting it would need a server-side contact list
  the user explicitly manages (e.g. saved contacts), which doesn't exist.
- **Group photos:** visible to current members; whoever may edit group
  info (`onlyAdminsCanEditInfo`) may change or remove it. A change writes
  one `photo.changed` system event (`{ actorId, removed }`) and a
  `chat.updated` hint, so every member's chat list, header and info
  screen refresh. Removing restores the generated avatar.
- **List photos:** owner only, in every route; recipients never see them
  (nothing about the list reaches their direct chats).
- **Downloads** are checked again every time a URL is issued, so a
  privacy change, block, removal or leaving a group applies to the next
  request. A URL already issued stays valid until it expires
  (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`, 5 min). Rate limit: 2000 photo URLs/h
  per user (clients cache by `photoId`); photo changes 60/h.
- **Profile photo changes** have no realtime event to other users; they
  see the new `photoId` the next time they load a chat list or profile.
- **Cleanup:** a replaced or removed photo's uploads are no longer
  referenced, and the media sweeper deletes them (the new photo is never
  touched; it is referenced). Deleting a group or list clears its photo
  first. Photo uploads never set are removed after
  `MEDIA_UNATTACHED_TTL_SECONDS` like any unused upload, and
  `pnpm media:reconcile` covers the photo prefixes.

## Push notifications

Pushes go through the [Expo Push Service](https://docs.expo.dev/push-notifications/sending-notifications/),
which forwards them to APNs (iOS) and FCM (Android). Only the backend
sends; the app never holds credentials that can send.

| Route                                | Purpose                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /devices/current/push-token`    | `{ pushToken: { registered, registeredAt } }`. Never returns the token.      |
| `PUT /devices/current/push-token`    | `{ token }` (`ExponentPushToken[…]`) → same shape. 30/h per device.          |
| `DELETE /devices/current/push-token` | Stop pushes to this device → 204. Idempotent.                                |
| `PUT /chats/:chatId/mute`            | `{ muted: true, duration?: "8h" \| "1w" \| "always" }` / `{ muted: false }`. |

**Device tokens.** A token always belongs to the device of the
authenticated session (`devices.push_token`); the request never names a
user or device. One app install has one token, so if another account
registers the same token on that phone, the previous device row loses it
(`push_token_revoked_reason = 'replaced'`). Signing out (and signing out
everywhere) clears the session's tokens (`'logout'`); unregistering is
`'unregistered'`; Expo reporting `DeviceNotRegistered` is `'invalid'`. A
user may have several devices, each notified separately. Tokens are
never logged and never returned by the API.

**Outbox.** Every user message (direct, group, and each direct message a
broadcast writes) inserts one `notification_jobs` row in the same
transaction as the message, so a rolled-back message never pushes and a
committed one is never lost. After the commit the server processes the
job immediately; the sweep (`PUSH_SWEEP_INTERVAL_MS`, and once at
startup) picks up anything a crash, restart or retry delay left behind.
Workers claim jobs with `FOR UPDATE SKIP LOCKED` and a lease
(`locked_until`), so several server processes can run safely. A push
failure never fails or delays the message request.

**Recipients** are resolved when the job is processed, and checked again
before every send attempt: active members other than the sender, who can
see the message (after their history start) and haven't read it yet,
whose account is active, with `user_settings.notifications_enabled` on, no
active mute for the chat, and no block either way. System events, deleted
messages and deleted groups never notify. Each eligible device with a
token and a live session gets one `push_deliveries` row (unique per job
and device), so a message pushes a device at most once.

**Payload.** Generic text only: body "New message" or "New group message",
no title, sender name, group name, preview, phone number or URL. `data` is
`{ type: "direct_message" | "group_message", chatId, messageId,
notificationId }`; the app routes taps from `chatId` after an
authenticated fetch (so a removed member lands on an error, not content).
Android channel `messages`, priority high, TTL 24 h, and `badge` = unread
messages from others in the recipient's unmuted chats. Broadcast pushes
look exactly like direct messages from the owner; nothing about the list
is included. Message bodies are opaque ciphertext to the server, but they
are **not** end-to-end encrypted today.

**Delivery and errors.** Expo accepts up to 100 messages per request.

- Request failures: timeouts, network errors, HTTP 429 (honouring
  `Retry-After`) and 5xx are retried; other 4xx are permanent.
- Ticket errors: `DeviceNotRegistered` fails the delivery and revokes the
  token; `MessageRateExceeded` / `ExpoError` are retried; anything else
  (`MessageTooBig`, `InvalidCredentials`, …) is permanent.
- Retries back off exponentially (2 s × 2^attempt, capped at 5 min) with
  jitter, up to `PUSH_MAX_ATTEMPTS` per device. A job not sent within
  `PUSH_MAX_AGE_SECONDS` of the message is dropped (`expired`) rather than
  sending a stale alert.
- **Receipts:** an `ok` ticket only means Expo accepted the push
  (`accepted`). After `PUSH_RECEIPT_DELAY_SECONDS` the sweep fetches
  receipts (up to 1000 per request): `ok` → `provider_delivered` (handed
  to APNs/FCM — still not proof the user saw it); errors are recorded and
  `DeviceNotRegistered` revokes the token. Receipts not available within
  24 h are abandoned.
- Finished jobs and their deliveries are deleted after 7 days.
- Logs carry job and delivery ids, counts and error codes — never tokens,
  message content, phone numbers or the access token.

**Mutes.** `chat_members.muted_until` per member. The server computes the
expiry from its own clock (`NOW() + 8 hours` / `+ 7 days`; "Always" is
9999-12-31); clients cannot send a timestamp. A mute is active only while
`NOW() < muted_until`, so notifications resume on their own; the sweep
also clears expired values. Unmuting is immediate, and repeating a
request is harmless. Chat summaries carry `muted` and `mutedUntil` (the
expiry, or `null` when not muted or muted forever) for the caller only —
nobody can see or change another member's mute. Only active members can
mute (`CHAT_NOT_FOUND` otherwise). 60 changes/min per user.

**Configuration.** `EXPO_PUSH_API_URL`, `EXPO_ACCESS_TOKEN` (only when the
Expo project has "Enhanced push security" on; server-side secret),
`PUSH_REQUEST_TIMEOUT_MS`, `PUSH_SWEEP_INTERVAL_MS`, `PUSH_MAX_ATTEMPTS`,
`PUSH_MAX_AGE_SECONDS`, `PUSH_RECEIPT_DELAY_SECONDS` (see
`.env.example`). APNs keys and the FCM v1 service-account key are
uploaded to Expo (EAS credentials), not to this server. Tests replace
the provider with a fake, so they never call Expo.

## Conversation details: shared content, stars, Clear Chat, groups in common

All routes require a session; the user is always the authenticated one,
and chats answer 404 to non-members (lists to anyone but the owner).
Pages are newest first: pass the last item's `sequence` as `before`
(`limit` 1–100, default 50) until `hasMore` is false.

| Route                                                                                              | Purpose                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /chats/:chatId/shared?kind=media\|docs`                                                       | Photos, videos and audio, or documents: `{ messages, hasMore }` with attachment metadata. Live messages within the caller's visible history only.                                        |
| `GET /broadcasts/:listId/shared?kind=media\|docs`                                                  | The owner's broadcast files after the list's clear marker: `{ broadcasts, hasMore }`. Files come from `GET /media/uploads/:id/url`.                                                      |
| `PUT` / `DELETE /chats/:chatId/messages/:messageId/star`                                           | Star / unstar (idempotent, rate limited with reactions' budget). System and deleted messages can't be starred.                                                                           |
| `GET /chats/:chatId/starred`                                                                       | The caller's stars in the chat; `inHistory` is false for stars kept through Clear Chat.                                                                                                  |
| `PUT` / `DELETE /broadcasts/:listId/messages/:broadcastId/star`, `GET /broadcasts/:listId/starred` | A broadcast's star is the owner's star on a copy it was delivered as: starring marks the earliest live copy, unstarring clears every copy; the starred list has one entry per broadcast. |
| `POST /chats/:chatId/clear` `{ keepStarred }`                                                      | Clear Chat for the caller only.                                                                                                                                                          |
| `POST /broadcasts/:listId/clear` `{ keepStarred }`                                                 | Clear the owner's list view only.                                                                                                                                                        |
| `GET /users/:userId/groups-in-common`                                                              | `{ groups: [{ chatId, name, photoId, memberCount }] }`, by name.                                                                                                                         |

**Links** are not served: message bodies are opaque to the server, so the
app finds links in the messages it has decrypted and cached, and fetches
no previews (so the server makes no requests to user-supplied URLs).

**Clear Chat** never deletes messages and sends nothing to other members.
Under the chat lock it sets `chat_members.cleared_through_sequence` to the
chat's latest sequence and raises `history_from_sequence` to match, so
every existing read path (history, search caches, previews, unread counts,
replies, attachments, notifications) hides those messages from that member
only. The marker only grows and survives leaving and rejoining a group. A
cleared direct chat stays in the list (`cleared_at`), and summaries carry
`clearedThroughSequence` so other devices purge their caches even if they
missed the `chat.cleared` event. With `keepStarred: false` the caller's
stars on cleared messages are deleted; with `true` they stay listed and
their attachments stay downloadable. For broadcast lists the marker is
`broadcast_lists.cleared_through_seq` against `broadcast_messages.history_seq`.
Recipients' chats, and the owner's own direct chats, are untouched. Stars
are removed when a message is deleted for everyone.

## API documentation

Not generated yet. Request schemas are Zod (`src/modules/*/*.schemas.ts`) so
OpenAPI can later be derived from them.
