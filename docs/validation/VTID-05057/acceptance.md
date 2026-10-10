# VTID-05057 — contacts: match members by verified phone (E.164)

Part A of the sparred plan in `plan-sparring.md` (Part B, the one-tap app flow, is VTID-05058 in exafyltd/vitana-v1).

## What changed
- `contacts-import.ts`: every imported number is normalised to E.164 (`libphonenumber-js` 1.11.18, pinned; region from the request, default DE). A contact links to a member when an e-mail matches (as before) **or** a number equals a member's `profiles.phone_e164` with `phone_verified` and `discoverable_by_phone` true. Test/service accounts stay excluded; the importer is never matched to themselves. Numbers are stored in `metadata.phones_e164` and, once the migration is applied, `contacts.contact_phone_e164`. The result reports `truncated` when an import was over the 5,000 cap.
- **Before the migration is applied** (it is applied at Gate 2) the phone query fails → no phone matches, and the upsert never names the missing column (probed and cached 10 min). The import keeps working exactly as today.
- `hub.importDeviceContacts(userId, contacts, { region, method })`: `method` ∈ picker | vcf | native (anything else → picker), recorded as `metadata.import_method`. New `removeDeviceContacts` + `DELETE /api/v1/connected-apps/android-contacts` (OASIS `connected_app.contacts_removed`).
- Migration `20261010160000_vtid_05057_contacts_phone_matching.sql`: columns only (constant defaults, no rewrite), auth.users → profiles verification mirror, `match_existing_contacts()` / `check_phone_on_platform()` rewritten to verified + discoverable + excluded-accounts. Live state read 2026-10-10: 238 profiles, 4 with a typed phone, **0** confirmed auth phones — so phone matching finds no one until members verify a number (phone verification is a separate follow-up plan).

## Evidence
- Jest: `test/vtid-05057-contacts-phone-matching.test.ts` (13), `test/routes/connected-apps.test.ts` (8, contract updated on purpose: the route now forwards `{ region, method }`; plus DELETE), and every suite that touches connected apps (13 suites, 203 tests) — `outputs/jest.txt`.
- Migration run against a throwaway local Postgres 16 with a minimal copy of the touched tables: typed-only number never matches; confirmed number links exactly one row per address book without a unique violation; opt-out/opt-in; service + test accounts never linked; un-confirming clears the mirror; point lookup international-only; idempotent re-run — `outputs/migration-test.txt`. Rollback (`rollback.down.sql`) applied cleanly on the migrated local DB.
- `npx tsc --noEmit` clean.

## Not done here
- Applying the migration to the shared database: at Gate 2, via `RUN-MIGRATION.yml`.
- A member phone-verification flow (SMS provider decision) — separate plan.

## Acceptance criteria

AC-1 Imported numbers are normalised to E.164 in the importer's region (national, `00`, `+`, spaces).
TEST: services/gateway/test/vtid-05057-contacts-phone-matching.test.ts — "phone normalisation" (3 cases)

AC-2 A contact links to a member by number only when the number is verified and the member is discoverable; never a test/service account; never the importer.
TEST: services/gateway/test/vtid-05057-contacts-phone-matching.test.ts — "links a contact to a verified, discoverable member…", "never matches the importer to themselves"

AC-3 Before the migration is applied the import still succeeds, finds no phone matches and never writes the missing column.
TEST: services/gateway/test/vtid-05057-contacts-phone-matching.test.ts — "before the migration: …"

AC-4 Device import forwards `method` (picker | vcf | native, anything else → picker) and `region`; `DELETE /android-contacts` removes only the caller's phone contacts and emits `connected_app.contacts_removed`.
TEST: services/gateway/test/vtid-05057-contacts-phone-matching.test.ts — "hub + route"; services/gateway/test/routes/connected-apps.test.ts

AC-5 The migration adds columns without a rewrite, mirrors verification from auth.users, and both older phone matchers require a verified, discoverable number and skip test/service accounts; re-running it and rolling it back are safe.
TEST: docs/validation/VTID-05057/migration-test.sql on a throwaway local Postgres 16 (outputs/migration-test.txt); services/gateway/test/vtid-05057-contacts-phone-matching.test.ts — "migration"

AC-6 Existing contacts-import behaviour is unchanged (collisions, Google/Outlook/iCloud, Android import).
TEST: services/gateway/test/vtid-04439-contacts-import-collisions.test.ts, test/vtid-04402-connected-apps.test.ts, test/vtid-04449-outlook-contacts.test.ts (outputs/jest.txt)
