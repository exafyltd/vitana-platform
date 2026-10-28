# VTID-05095 — members verify their own phone number (SMS code)

ROUTE_MOUNT: new router `src/routes/me-phone.ts` mounted at `/api/v1/me/phone` in `src/index.ts` (owner `me-phone`, mounted just before the `/api/v1/me` context router), `requireAuth` on the whole router. Routes: `GET /`, `POST /verification`, `POST /verification/confirm`, `DELETE /`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/me/phone (staging).

CURL_PROOF: GET `/api/v1/me/phone` with an invalid bearer and anonymous POST `/verification`, POST `/verification/confirm`, DELETE `/api/v1/me/phone` answer 401 application/json (staging-tests.json rejected probes). Authenticated behaviour is proven by Jest (rule 48: no writes and no SMS on staging); the signed-in read of `GET /api/v1/me/phone` is in the VTID-05096 community-app staging spec.

OASIS_PROOF: none — this change emits no OASIS event. It is a member's own settings action (like the existing Settings → Privacy toggles), not a task-state transition; every refusal and failure is logged by the gateway (`[phone-verification]`, `[me-phone]`).

Part A of the sparred plan in `plan-sparring.md` (Part B, the app screens, is VTID-05096 in exafyltd/vitana-v1).

## What changed
- `POST /api/v1/me/phone/verification { phone, region? }`: normalises with `libphonenumber-js/max` (mobile numbers only; countries from `PHONE_VERIFY_COUNTRIES`, default DE, AT, CH), refuses test/service accounts (strict exclusion lookup — a lookup error also refuses) and numbers already verified on another account, then `phone_verification_begin` checks the limits and writes the one open challenge in one transaction; only then is the SMS sent through AWS End User Messaging SMS (`SendTextMessage`, TRANSACTIONAL) in the member's language (`sms.phone_verification.code`, all 11 locales).
- `POST /verification/confirm { code }`: `phone_verification_confirm` checks the HMAC, counts the attempt (max 5), expiry 10 min, one use; on success the number is checked again for another account and written to Supabase Auth with `phone_confirm: true`. VTID-05057's trigger mirrors it to `profiles` and links matching contacts. Auth duplicate errors (422 `phone_exists`, Postgres 23505) map to 409 `PHONE_IN_USE`.
- `DELETE /api/v1/me/phone`: clears the Auth phone; the mirror marks the profile unverified and the new `on_phone_a_withdrawn` trigger unlinks phone-based matches.
- `GET /api/v1/me/phone`: `{ enabled, verified, phone_masked, discoverable, resend_after_seconds }`.
- Off unless `PHONE_VERIFY_ENABLED=true`; on without a ≥ 32-byte `PHONE_VERIFY_HMAC_SECRET` every write answers 503 `PHONE_VERIFY_MISCONFIGURED` and the gateway logs an error at boot and per call. Per-IP backstop of 30 requests / 15 min on the two POSTs.
- Migration `20261012180000_vtid_05095_phone_verification.sql`: `phone_verification_challenges` (UNIQUE user_id), `phone_verification_sends` (limits; 7-day purge), the two functions (service role only, advisory lock), `unmatch_phone_contacts()` + `on_phone_a_withdrawn`.
- `@aws-sdk/client-pinpoint-sms-voice-v2` `~3.1135.0` — the version whose `@aws-sdk/core` / credential-provider ranges match the ones already locked, so no other AWS package moves (npm and pnpm lockfiles: one package added, nothing bumped).

## Evidence
- Jest: `test/vtid-05095-phone-verification.test.ts` (36 tests, `outputs/jest-vtid-05095.txt`); with every suite that reads the route mounts, the catalog, the domain atlas or the exclusion helper: 52 suites / 1,115 tests pass (`outputs/jest.txt`).
- Migration on a throwaway local Postgres 16, applied twice on top of VTID-05057's: limits, one challenge per member, attempts / expiry / single use, privileges (anon and members refused; service role allowed), and the full chain auth → profile → link → remove → unlink (phone-only unlinked, e-mail-linked kept, case-insensitive), replace number (old unlinked, new linked), hide (unlinked), unrelated edits (nothing) — `outputs/migration-test.txt`. Two concurrent sends for one member: one challenge, both logged; with an hourly limit of 1, the second concurrent send is refused (`commands.log`). Rollback applied cleanly.
- `npx tsc --noEmit` clean.

## Not done here
- Applying the migration to the shared database: at Gate 2, via `RUN-MIGRATION.yml`.
- Switching the feature on: owner's AWS setup first (SMS out of sandbox in eu-central-1, sender ID / origination for the allowed countries, spend limit, `sms-voice:SendTextMessage` on the task roles, `PHONE_VERIFY_HMAC_SECRET` in Secrets Manager), then a separate change and Gate 2. The What's New entry ships with that change.

## Acceptance criteria

AC-1 Off unless `PHONE_VERIFY_ENABLED` is exactly `true`; on without a ≥ 32-byte secret every write answers 503 `PHONE_VERIFY_MISCONFIGURED` and nothing is hashed, written or sent.
TEST: services/gateway/test/vtid-05095-phone-verification.test.ts — "switch and secret"

AC-2 Numbers are normalised to E.164; only mobile numbers in the allowed countries are accepted.
TEST: services/gateway/test/vtid-05095-phone-verification.test.ts — "number normalisation"

AC-3 A code is sent only after the limits pass and the one open challenge is written; test/service accounts and numbers verified on another account never get an SMS; the SMS is in the member's language and the code is stored only as an HMAC.
TEST: services/gateway/test/vtid-05095-phone-verification.test.ts — "sending the code"; docs/validation/VTID-05095/migration-test.sql (outputs/migration-test.txt)

AC-4 A correct code within 10 minutes and 5 attempts saves the number to Supabase Auth as confirmed; wrong, expired, exhausted, missing codes and numbers taken in the meantime save nothing.
TEST: services/gateway/test/vtid-05095-phone-verification.test.ts — "confirming the code"

AC-5 Removing, hiding or replacing a verified number unlinks other members' phone-based matches and keeps e-mail-based ones; the migration is idempotent, service-role only and rolls back cleanly.
TEST: docs/validation/VTID-05095/migration-test.sql on a throwaway local Postgres 16 (outputs/migration-test.txt); services/gateway/test/vtid-05095-phone-verification.test.ts — "migration"

AC-6 The routes need a signed-in member, act only on the caller, and answer JSON errors.
TEST: services/gateway/test/vtid-05095-phone-verification.test.ts — "routes"
