# Plan sparring record — VTID-05095 + VTID-05096 (members verify their own phone number)

- **VTIDs:** VTID-05095 (gateway: SMS code, routes, migration, exafyltd/vitana-platform), VTID-05096 (frontend: Settings → Privacy card, verify dialog, Find friends hint, exafyltd/vitana-v1). One plan, two deliveries.
- **Sparring sessions:** `plan_sparring_sessions.id = 74fcbe48-9c09-4c67-9400-983d6fe18931` (VTID-05095), `6edf915c-c07c-447f-93c1-92943512af45` (VTID-05096); both VTIDs allocated with `p_sparring_id` and the plan hash.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Change class:** standard. **Rounds:** 3. **Verdict:** CONVERGED.
- **Plan hash (final, sha256 of the text between the plan markers):** `0f1a5f4f059f6f087c3bae5ef781ac0bbfb76bc4a2fecbf50ca0496201ede57f`
- **Owner approval:** Gate 1 in Claude Code session https://claude.ai/code/session_01CRi9L1TVjrdCCLgwFPUCnz, 2026-10-12 — "Yes". Binding exafy_admin approval click pending.
- **Production write in this plan:** the VTID-05095 migration, applied only after the owner's Gate 2 "yes" and listed in the Gate 2 message. The feature ships with `PHONE_VERIFY_ENABLED` off; switching it on is a separate, later Gate 2 after the owner's AWS SMS setup.

## Round 1 — NOT CONVERGED (0 blockers, 3 majors, 4 minors)

Partner findings (verbatim titles): F1 [major] `auth.users.phone` uniqueness is assumed but not a guaranteed Supabase contract for admin-set phones; F2 [major] Missing fail-loud behavior when `PHONE_VERIFY_HMAC_SECRET` is unset; F3 [major] Challenge upsert race condition on concurrent sends; F4 [minor] What's New entry likely required but not mentioned; F5 [minor] Line reference for Polly lazy singleton is off; F6 [minor] SMS text key needs all 11 gateway locales; F7 [minor] No screen-registry consideration for the verify dialog. Questions: Q1 Admin API duplicate-phone error shape; Q2 un-match on DELETE; Q3 challenge table service-role only.

## Round 2 — NOT CONVERGED (0 blockers, 2 majors)

F1–F7 closed/acknowledged (F4 rejection accepted by the partner). New: F8 [major] Un-matching heuristic (8b) will miss contacts with NULL contact_email; F9 [major] The existing `on_phone_verified` trigger only fires on positive transitions — 8b needs a new or expanded trigger for negative transitions. Questions: cascade auth.users → profiles → un-match; replaced number.

## Round 3 — CONVERGED

F8, F9 closed. No new blockers or majors. Firing order by trigger name (`on_phone_a_withdrawn` < `on_phone_verified`) confirmed against Postgres semantics.

## Final plan

<!-- plan:begin -->
## Goal
Find friends (VTID-05057/05058, live in production 2026-10-10) matches an imported contact to a
member only when that member's number is verified (`profiles.phone_verified = true`) and
discoverable. Today 0 members are verified because no verification flow exists, so phone
matching finds nobody. Build the flow: a member enters their number, gets a 6-digit SMS code,
types it in, and the number becomes verified and matchable.

## Change class
standard (new migration, new gateway routes, new AWS SMS dependency, frontend UI, i18n).

## Premises (verified read-only)
- No SMS/OTP path exists for a member's own phone. The only SMS sender is the Twilio bulk
  campaign queue (`vitana-v1/supabase/functions/process-campaign-queue/index.ts:233-258`), tied
  to campaign credentials — not reused.
- The gateway has no SNS / End User Messaging client (`services/gateway/package.json:36-44`);
  AWS clients are lazy singletons on the task role (`services/tts/polly.ts:240,251`).
- `profiles.phone` (free text, `AccountEditDrawer.tsx:251`) is never trusted for matching.
- Migration 20261010160000 mirrors `auth.users.phone` + `phone_confirmed_at` into
  `profiles.phone_e164` / `phone_verified` via trigger `sync_profile_phone_verification`, and
  `on_phone_verified` then re-runs `match_existing_contacts()` for that member.
- `requireAuth` (`middleware/auth-supabase-jwt.ts:384`), `express-rate-limit` patterns
  (`routes/creators.ts:33-43`), server catalog `tt()` (`src/i18n/catalog.ts`).

## Design
1. **SMS provider: AWS End User Messaging SMS** (`@aws-sdk/client-pinpoint-sms-voice-v2`,
   `SendTextMessage`, message type TRANSACTIONAL), region eu-central-1, task-role credentials.
   AWS-only, no new vendor, no Twilio, nothing on GCP. Sender: an alphanumeric sender ID
   `Vitana` where the destination country allows it, otherwise the account's default
   origination; configured by env (`PHONE_VERIFY_SENDER_ID`,
   `PHONE_VERIFY_CONFIGURATION_SET` optional).
2. **Code handling in the gateway (no Supabase SMS provider).** New table
   `phone_verification_challenges` (id, user_id, phone_e164, code_hash, expires_at, attempts,
   created_at, consumed_at). RLS enabled, no policies (service role only). The code is 6 random
   digits (crypto.randomInt), stored as HMAC-SHA256 with `PHONE_VERIFY_HMAC_SECRET`, TTL 10 min,
   max 5 wrong attempts, one open challenge per user: UNIQUE (user_id) and the send is a single
   `INSERT … ON CONFLICT (user_id) DO UPDATE` (new phone, new hash, attempts 0, consumed_at null),
   so concurrent sends cannot create two challenges; the SMS is sent only after the upsert
   returns, and the per-user rate limit is checked inside the same statement's WHERE. Rows older than
   7 days purged in the same insert path.
3. **Verified state written through Supabase Auth, not profiles directly:** on a correct code the
   gateway calls `auth.admin.updateUserById(userId, { phone: e164-without-plus, phone_confirm:
   true })`. The VTID-05057 trigger mirrors it to profiles and re-runs matching. `auth.users.phone`
   is unique, but the plan does not rely on the constraint's error shape: before sending AND
   again before `updateUserById` the gateway checks (service role) for another account whose
   `profiles.phone_e164` equals the number with `phone_verified = true`, and answers 409
   `PHONE_IN_USE`. Any error from `updateUserById` that names the phone / unique violation
   (GoTrue 422 or Postgres 23505) is also mapped to 409 `PHONE_IN_USE`; anything else is 502
   `PHONE_VERIFY_FAILED`, logged. No takeover path either way.
4. **Routes** (all `requireAuth`, JSON):
   - `POST /api/v1/me/phone/verification` `{ phone, region? }` → normalises with
     libphonenumber-js (already a dependency since VTID-05057), rejects non-mobile / invalid,
     rejects test/service accounts (`service_bot_accounts`, `notification_test_actors`) with 403
     so no automation account ever sends an SMS, sends the code. Returns `{ ok, expires_in }`.
   - `POST /api/v1/me/phone/verification/confirm` `{ code }` → checks, consumes, updates auth.
   - `DELETE /api/v1/me/phone` → clears the auth phone (`phone: ''`), trigger sets
     verified=false and phone_e164=null.
   - `GET /api/v1/me/phone` → `{ phone_e164 | null, verified, discoverable }` (masked number).
5. **Abuse and cost limits:** per user 3 sends/hour and 6/day; per destination number 5/day;
   global daily send cap `PHONE_VERIFY_DAILY_CAP` (default 200) checked by counting today's
   challenge rows; all limits answer 429 `TOO_MANY_REQUESTS`. Destination countries limited to
   an allowlist env `PHONE_VERIFY_COUNTRIES` (default `DE,AT,CH,RS,…` set by owner). The AWS
   account spend limit is the hard backstop (owner setting).
6. **Kill switch, ships dark, fails loud:** `PHONE_VERIFY_ENABLED` must be exactly `true`; otherwise all four
   routes answer 503 `PHONE_VERIFY_DISABLED`. If it is `true` but `PHONE_VERIFY_HMAC_SECRET` is
   missing or shorter than 32 bytes, every route answers 503 `PHONE_VERIFY_MISCONFIGURED` and the
   gateway logs an error at boot and on each call — never hashes with an empty key and the UI hides the verify entry points (it reads
   `GET /me/phone`, which reports `enabled:false`).
7. **SMS text** from the server catalog via `tt()` in the member's locale, translated in all 11
   gateway locales in this PR (one short sentence): "Dein Vitanaland-Code: 123456. Gib ihn
   niemandem weiter." No hardcoded per-language strings in code.
8. **Frontend (vitana-v1):**
   - Settings → Privacy: a "Your phone number" card above the existing discoverability toggle:
     shows the verified number (masked) with Change / Remove, or a "Verify phone number" button.
   - `VerifyPhoneDialog`: step 1 number (prefilled from `profiles.phone`, country from the
     existing `phoneRegionHint()`), step 2 six-digit code (`inputmode="numeric"`,
     `autocomplete="one-time-code"` so iOS/Android offer the SMS code), resend after 60 s,
     error states for every gateway error code.
   - Find friends results: one line "Verify your number so friends can find you" linking to the
     dialog, shown only when enabled and the member is unverified.
   - i18n: new keys under `mailhub.findFriends.verifyPhone.*`, DE first (du-form), all 11
     locales, RTL-safe (`bdi dir=ltr` for numbers).
   - No change to the free-text `profiles.phone` field.
   - `VerifyPhoneDialog` is a modal inside Settings → Privacy, not a route: no screen-registry entry.
   - No What's New entry while the switch is off (CLAUDE.md: nothing behind a flag); the entry is
     added in the PR that turns the switch on.
8b. **Un-matching on withdrawal (new trigger, same migration):** new function
   `unmatch_phone_contacts()` + trigger `on_phone_withdrawn` AFTER UPDATE OF phone_e164,
   phone_verified, discoverable_by_phone ON profiles, WHEN the OLD row was matchable
   (`OLD.phone_verified AND OLD.discoverable_by_phone AND OLD.phone_e164 IS NOT NULL`) and the NEW
   row is not, or `NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164` (number replaced). It clears
   `contact_user_id` (and `is_on_platform`) on other members' contacts WHERE
   `contact_user_id = NEW.user_id AND OLD.phone_e164 = ANY(contact_phone_e164)` AND
   `contact_email IS DISTINCT FROM <member's auth email>` (NULL-safe; rows also linked by email
   stay linked). The existing positive trigger `on_phone_verified` is untouched and still links the
   new number's contacts after a replacement (it fires after this one: trigger names sort
   `on_phone_verified` < `on_phone_withdrawn`, so the withdrawal trigger is named
   `on_phone_a_withdrawn` to run first). Chain tested end to end on local Postgres:
   `DELETE /me/phone` → auth.users.phone cleared → `sync_profile_phone_verification` → profiles
   phone_verified=false → `on_phone_a_withdrawn` un-links; and replace number → old links cleared,
   new links made.
9. **Owner-side setup before the switch is turned on in production (not code):** AWS End User
   Messaging SMS out of sandbox in eu-central-1, sender ID / origination for the allowed
   countries, monthly spend limit, IAM permission `sms-voice:SendTextMessage` on the prod and
   staging gateway task roles, secret `PHONE_VERIFY_HMAC_SECRET`. The code ships with the switch
   off; turning it on is a separate env change at a later Gate 2.

## Files in scope
vitana-platform: new migration `supabase/migrations/<ts>_vtid_XXXXX_phone_verification.sql`
(+ rollback in docs/validation), `services/gateway/src/services/phone-verification/*.ts`
(sms sender, challenge store, service), `services/gateway/src/routes/me-phone.ts` + mount in
`src/index.ts`, `services/gateway/src/i18n/locales/*` (SMS text keys), `package.json` /
`package-lock.json` / `pnpm-lock.yaml` (`@aws-sdk/client-pinpoint-sms-voice-v2`),
`DATABASE_SCHEMA.md`, `.claude/rules/infrastructure.md` §8 env list, tests, docs/validation.
vitana-v1: `src/components/settings/PhoneNumberCard.tsx`, `src/components/contacts/VerifyPhoneDialog.tsx`,
`src/lib/phone-verification-client.ts`, `src/pages/settings/Privacy.tsx`,
`src/components/contacts/ContactSyncModal.tsx` (one hint line), `src/i18n/*/mailhub.json`,
stamps + SCREEN_INVENTORY, tests, staging spec, docs/validation.

## Test plan
- Gateway Jest: normalisation and country allowlist; code generation/HMAC/TTL/attempts; one open
  challenge per user; each rate limit and the daily cap; test-account refusal; kill switch 503
  on every route; confirm success calls updateUserById with `phone_confirm: true`; PHONE_IN_USE
  mapping; DELETE clears; SMS sender mocked (never a real send in CI).
- Migration tested on a throwaway local Postgres 16 (apply twice, RLS no-policy check).
- Frontend Vitest: dialog steps, resend timer, every error code, hidden when disabled, RTL.
- STAGING-VERIFY (read-only): the four routes answer 401 JSON unauthenticated; signed-in
  `GET /api/v1/me/phone` answers 200 with `enabled:false` (switch off); Privacy page renders
  without the verify button while disabled. No SMS is sent and nothing is written on staging.
- The real end-to-end send is tested by the owner on their own phone after the owner-side setup,
  with the switch on — never by an automated test against production.
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED — design §3: application pre-check (before send and before updateUserById) against verified profiles.phone_e164, plus mapping of GoTrue 422 / Postgres 23505 to 409 PHONE_IN_USE, other errors 502; Jest case for the mapped duplicate error.
- F2 [major] ACCEPTED — design §6: enabled without a ≥32-byte HMAC secret → 503 PHONE_VERIFY_MISCONFIGURED on every route + error log at boot and per call; Jest case.
- F3 [major] ACCEPTED — design §2: UNIQUE(user_id) and a single INSERT … ON CONFLICT (user_id) DO UPDATE; SMS sent only after the upsert returns; Jest/local-Postgres concurrency case.
- F4 [minor] REJECTED for this PR — vitana-v1 CLAUDE.md (VTID-04733) says no What's New entry for anything behind a flag; the feature ships with the switch off. The entry goes into the later PR that turns the switch on (recorded in design §8).
- F5 [minor] ACCEPTED — reference corrected to polly.ts:240,251.
- F6 [minor] ACCEPTED — design §7: SMS text translated in all 11 locales in this PR.
- F7 [minor] ACCEPTED — design §8 states the dialog is a modal, no screen-registry entry.
- Q1: not verified live (would need a write); the pre-check makes the plan independent of the error shape.
- Q2: yes — new design §8b un-links phone-based matches when a member un-verifies or turns discoverability off.
- Q3: yes — the challenge table is service-role only; the gateway uses the service-role client for it.

## Planner responses — round 2
- F8 [major] ACCEPTED — §8b now selects phone-linked rows positively (`OLD.phone_e164 = ANY(contact_phone_e164)`) and compares e-mail NULL-safe (`IS DISTINCT FROM`).
- F9 [major] ACCEPTED — §8b specifies a separate trigger with its own WHEN for the negative transition and for a replaced number; the existing positive trigger is unchanged; firing order fixed by name.
- Q1: yes, the cascade auth.users → profiles → un-match is intended; it is a local-Postgres test case.
- Q2: yes — a replaced number now un-links the old number's matches (WHEN includes `phone_e164 IS DISTINCT FROM`), and the existing trigger links the new one.
