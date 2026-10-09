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
a placeholder `MSG91_AUTH_KEY`. Auth tests inject `FakeIdentityVerifier`
(`tests/helpers/`) and MSG91 verifier tests stub `fetch`, so no test ever calls
MSG91. Test helpers refuse to truncate unless the database name ends in `_test`
and the Redis db is not 0. Run `pnpm db:test:prepare` once (and after adding
migrations).

## Authentication

Email sign-in with a one-time code. MSG91 proves the user owns the email; the
backend owns users, devices, sessions and tokens.

1. The app initialises the MSG91 OTP widget SDK with the widget ID and widget
   token (`EXPO_PUBLIC_MSG91_*` in the mobile app's `.env.local`).
2. `OTPWidget.sendOTP({ identifier: email })` → MSG91 emails a code and
   returns a request id. `retryOTP` resends it.
3. `OTPWidget.verifyOTP({ reqId, otp })` → MSG91 checks the code and returns
   an access token (JWT).
4. The app calls `POST /auth/email/verify` with `{ accessToken, device }`.
5. The backend calls `POST {MSG91_API_BASE_URL}/api/v5/widget/verifyAccessToken`
   with `{ authkey: MSG91_AUTH_KEY, "access-token": accessToken }`. A success
   response (`{"type":"success","message":"<email>"}`) carries the verified
   email, which is the only email the backend trusts.
6. The backend finds or creates the user (stamping `email_verified_at`),
   registers the device and issues its own access and refresh tokens.

The backend never generates, stores or checks OTPs, and never stores the
MSG91 access token (only a SHA-256 fingerprint in Redis, for 24 hours, so each
token can create one session).

| Route                     | Auth   | Purpose                                                |
| ------------------------- | ------ | ------------------------------------------------------ |
| `POST /auth/email/verify` | –      | Exchange `{ accessToken, device }` for tokens + user.  |
| `POST /auth/refresh`      | –      | Rotate `{ refreshToken }`; returns a new token pair.   |
| `POST /auth/logout`       | Bearer | Revoke the current session.                            |
| `POST /auth/logout-all`   | Bearer | Revoke every session for the user.                     |
| `GET /auth/me`            | Bearer | Current user and device.                               |
| `PATCH /users/me`         | Bearer | Update `{ displayName?, dateOfBirth? }`; returns user. |

`PATCH /users/me` powers onboarding. `displayName` is trimmed, 1–50
characters; `dateOfBirth` is `YYYY-MM-DD` and the user must be at least 16
(measured against today's UTC date). The app treats a user without both
fields as still needing onboarding.

Errors are always `{ "error": { "code", "message", "details?" } }`. Email
verification can fail with `VERIFICATION_FAILED` (401: MSG91 rejected the
token, it was already used, or it proves a non-email identity),
`VERIFICATION_UNAVAILABLE` (502: MSG91 unreachable, or our auth key was
rejected), `RATE_LIMITED` (429), `ACCOUNT_UNAVAILABLE` (403) or
`VALIDATION_ERROR` (400).

- **Access tokens** are HS256 JWTs (`sub`, `sid`, `did` only) valid for
  `AUTH_ACCESS_TOKEN_TTL_SECONDS`. The `authenticate` hook also checks the
  session is still active, so logout takes effect immediately.
- **Refresh tokens** are `<sessionId>.<secret>`; only a SHA-256 of the secret
  is stored. Every refresh rotates the token, and presenting an already-rotated
  token revokes the session.
- **Rate limits:** `/auth/email/verify` is limited per IP and per verified
  email in Redis (`AUTH_VERIFY_*`). OTP send, resend and attempt limits are
  configured on the MSG91 widget. If Redis is down, the rate limiter and
  replay guard fail open; MSG91 still verifies every token.
- **Logging:** provider reasons and MSG91 error codes are logged; OTPs, access
  tokens, refresh tokens and the auth key never are.

### MSG91 setup

- **Widget:** MSG91 → OTP → Widgets → create (or open) a widget with Email
  enabled. Set the OTP length (the app supports
  4–8, 6 recommended), expiry, resend interval and resend count there; the app
  reads them via `getWidgetProcess`. Copy the **widget ID** and **token** into
  the mobile app's `.env.local`.
- **Auth key:** MSG91 → profile → Authkey. Put it in the backend `.env` as
  `MSG91_AUTH_KEY`. New auth keys have API security (IP whitelisting) on by
  default: whitelist the server's public IPs — both IPv4 and IPv6 if the
  network has IPv6 — or turn API security off for local development. MSG91
  answers a wrong key with code `201` and a non-whitelisted IP with `418`; the
  backend logs the reason and returns 502 `VERIFICATION_UNAVAILABLE`.
- **Email delivery:** configure the widget's email template/sender in MSG91.

Verification is behind `IdentityVerifier` (`src/modules/auth/verification/`).
SMS OTP is another MSG91 widget channel: the verifier already maps phone
identifiers to the `sms` channel, so it needs a phone route and the
`phone_number` user path, not a new auth flow.

## Direct messaging

Postgres is the source of truth; the WebSocket only tells clients that
something changed. Clients store messages in an on-device SQLite cache and
resync over REST after every (re)connect.

| Route                            | Purpose                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /chats`                     | Chat summaries with at least one message, newest first.                              |
| `POST /chats/direct`             | Open (or create) the direct chat with `{ userId }`. Idempotent per pair of users.    |
| `GET /chats/:chatId`             | One chat summary (members only).                                                     |
| `PUT /chats/:chatId/mute`        | `{ muted }`.                                                                         |
| `POST /chats/:chatId/receipts`   | Advance `{ deliveredSequence?, readSequence? }` for the caller.                      |
| `GET /chats/:chatId/messages`    | `?after=` (ascending, for sync) or `?before=` / latest (paging back); `limit` 1–100. |
| `POST /chats/:chatId/messages`   | `{ clientMessageId, type: "text", ciphertext }` → 201 created, 200 for a retry.      |
| `POST /users/discover`           | `{ phoneHashes }` (lowercase hex SHA-256 of E.164 numbers, ≤ 1000) → matching users. |
| `GET /users/:userId`             | Public profile (`displayName`, `available`, `blockedByMe`); never phone or email.    |
| `PUT /privacy/blocks/:userId`    | Block (idempotent, 204).                                                             |
| `DELETE /privacy/blocks/:userId` | Unblock (204).                                                                       |
| `POST /privacy/reports`          | `{ userId, chatId?, reason, block }` → `{ reported, blocked }`.                      |

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
  block is never revealed. Discovery hides users in either direction.
- **Bodies** are opaque base64 (`ciphertext`, ≤ 48 KiB). Today the app sends
  UTF-8 text; end-to-end encryption can replace the encoding without API
  changes.
- **Rate limits:** sending 120/min per user, discovery 20/hour, reports
  20/day.
- **Discovery** compares the client's hashes with
  `users.phone_number_sha256` (a generated column, migration 005). Only users
  with a verified phone number can be found.

### Realtime

`GET /ws` upgrades to a WebSocket authenticated by the
`Authorization: Bearer` header (same access token and session check as
REST). Events are JSON:

- `connection.ready` — sent once after connecting.
- `message.new` — `{ chatId, message }`, to every member, including the
  sender's other devices.
- `receipt.updated` — `{ chatId, userId, deliveredSequence, readSequence }`
  (`readSequence` is null for the peer when read receipts are hidden).
- `pong` — reply to a client `{ "type": "ping" }`.

Events fan out through Redis (`rt:user:<id>` channels) so any API instance
can deliver them; if Redis is down, events still reach sockets on the same
instance. The server pings every 30 s and drops sockets that stop
answering. Sockets aren't closed when a session is revoked; they fail
authentication on the next reconnect.

## API documentation

Not generated yet. Request schemas are Zod (`src/modules/*/*.schemas.ts`) so
OpenAPI can later be derived from them.
