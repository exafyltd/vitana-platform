# Plan sparring record — VTID-05057 + VTID-05058 (one-tap phone contacts: find friends + invite to Maxina)

- **VTIDs:** VTID-05057 (gateway: phone matching + migration, exafyltd/vitana-platform), VTID-05058 (frontend: one-tap flow + real invites, exafyltd/vitana-v1). One plan, two deliveries (plan §7).
- **Sparring sessions:** `plan_sparring_sessions.id = 85bcd71a-4c05-467f-8c78-3b0516efe176` (VTID-05057), `0fafa2b9-8f9a-40bb-a3ed-13535890b5e7` (VTID-05058); both VTIDs allocated with `p_sparring_id` and the plan hash.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Change class:** standard. **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hash (final, sha256 of the text between the plan markers):** `823f2058fb13892f81038b1a1d6c0bd5310ba64be787106a286e006594f171e7`
- **Owner approval:** Gate 1 in Claude Code session https://claude.ai/code/session_01CRi9L1TVjrdCCLgwFPUCnz, 2026-10-10 — "Yes, build it. Non-stop in one go". Binding exafy_admin approval click pending.
- **Production write in this plan:** the VTID-05057 migration. It is applied only after the owner's Gate 2 "yes" and is listed in the Gate 2 message. The gateway code ships tolerant of the columns being absent (phone matching then finds no one).

## Round 1 — NOT CONVERGED (1 blocker, 4 majors, 4 minors)

Partner findings (verbatim titles): F1 [major] verified-phone mechanism unspecified (`phone_confirmed_at` not exposed); F2 [major] existing `match_existing_contacts()` raw matching conflicts; F3 [major] `useContacts.addContact` client-side raw phone match; F4 [major] four i18n violations in `InviteFriends.tsx`; F5 [minor] libphonenumber bundle size on the frontend; F6 [minor] N+1 avatar query in `useContacts.ts`; F7 [minor] route alias duplicates the existing route; F8 [minor] vCard parser cap; F9 [blocker] backfill of `profiles` inside the migration would rewrite a hot table.

## Round 2 — CONVERGED

F1–F9 closed. New: F10 [minor] trigger must require both `phone` and `phone_confirmed_at`; F11 [minor] state the migration's repo. Both accepted.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard (gateway route + service change, one migration, frontend flow).
- **Scope (areas):**
  - vitana-v1: `src/hooks/useContactSync.ts`, `src/components/contacts/{ContactSyncModal,ContactSourcePicker,ImportContactsButton,InviteComposer,DedupePreviewList,ContactsTabContent,SyncSuccessScreen}.tsx`, `src/pages/InviteFriends.tsx`, `src/hooks/useContacts.ts` (`inviteContact`), `src/lib/connected-apps-client.ts`, new `src/lib/contact-invite-links.ts`, new `src/lib/vcard.ts`, `src/i18n/{de,en,…}/screens.json|mailhub.json|toasts.json`, tests.
  - vitana-platform: `services/gateway/src/services/connected-apps/contacts-import.ts`, `routes/connected-apps.ts`, one migration (normalized phone column + discoverability setting), `DATABASE_SCHEMA.md`, gateway tests.

## 1. Current state (verified in code 2026-10-10)
- A "Find friends" flow exists: Messages → Contacts tab → `ImportContactsButton` → `ContactSyncModal` (consent → source grid → sync → success → preview → invite). Sources: Google, Outlook, iCloud (Connected Apps hub, must be connected first in /connectors), phone book (`navigator.contacts` Contact Picker). Separate `/invite` page (`InviteFriends.tsx`) and `InviteSheet` (personal `/i/<code>` link, copy + wa.me).
- **Phone book does not work in the Maxina store app:** the store apps are an Appilix WebView (`src/lib/appilix.ts`); the Contact Picker API exists only in Chrome on Android, not in Android WebView, iOS Safari or WKWebView. So the phone tile is greyed out ("unavailable") for nearly every app user. Appilix exposes no contacts bridge in our code.
- **Matching is email-only:** `contacts-import.ts` matches `profiles.email`; phones are stored raw, never normalized or matched. Phone-only address books (the normal phone case) find zero members.
- **Invites are fake:** `useContacts.inviteContact` only sets `contacts.invite_sent_at` and toasts "Invite sent"; `ContactSyncModal.handleSendInvites` and `handleConnect` are TODO `console.log`s; `InviteFriends.handleSend` toasts "N invites sent!" (hardcoded English). Nothing is sent and the personal invite code is not used.
- Working pieces to reuse: gateway import + per-source dedupe + exclusion of `service_bot_accounts`/`notification_test_actors`; `/api/v1/invites/me` personal link + `/i/:code` landing + claim attribution; `Messages.handleMessageContact` to open a DM.

## 2. Goal / UX (WhatsApp/Telegram pattern)
One primary button **"Find friends from my contacts"** (Messages → Contacts tab, Inbox empty state, InviteSheet, /invite page — all open the same flow):
1. One-time consent card (what is uploaded, why, how to delete) — existing card, copy updated.
2. **Tap 1 = import.** The flow picks the best available source automatically instead of showing a grid first:
   - Native bridge present (future native app, see §3.4) → read all contacts, no picker.
   - Contact Picker supported (Android Chrome) → picker opens, user taps "select all".
   - Otherwise (iOS, Appilix app, desktop) → a single screen with the two paths that work there: **"Import contacts file (.vcf)"** with 3-line device-specific instructions (iPhone: Contacts → Lists → All Contacts → long-press → Export; Android: Contacts → Fix & manage → Export to file), and **Google / Outlook / iCloud** (existing hub, connect inline).
   - "More sources" link keeps the existing grid for users who want multiple sources.
3. Result screen, two sections like messengers:
   - **"On Maxina (N)"** — avatar, name, **Message** button (opens DM via existing `handleMessageContact`), "Message all"? no — per-person only.
   - **"Invite to Maxina (M)"** — search, per-row **Invite** button; tapping opens the user's own channel prefilled with their personal link `/i/<code>`: WhatsApp (`https://wa.me/<E164>?text=`), SMS (`sms:<phone>?&body=`), email (`mailto:`), or `navigator.share`. Row then shows "Invited" (not "sent").
4. Contacts tab afterwards shows the same two sections persistently (already exists), with "Remove imported contacts" in an overflow menu.

Vitanaland never sends SMS/email to non-members itself (matches `invites.ts` policy; no spam/consent/cost risk).

## 3. Work items
### 3.1 Gateway — phone matching (vitana-platform)
- Add `libphonenumber-js` to the gateway only; normalize every imported phone to E.164 using the importer's default region (profile country / locale, fallback DE). The gateway returns E.164 numbers in the import response and stores them, so the frontend needs no phone library (invite URLs use the stored E.164).
- Migration in `vitana-platform/supabase/migrations/` (metadata-only, no table rewrite, no backfill inside the migration): `contacts.contact_phone_e164 text[]` + GIN index; `profiles.phone_e164 text` + partial index; `profiles.phone_verified boolean NOT NULL DEFAULT false`; `profiles.discoverable_by_phone boolean NOT NULL DEFAULT true` (PG 11+ constant default = instant). `phone_e164` for existing profiles is filled by a separate batched gateway script (500 rows/batch), not in the migration.
- **Verified phone source:** a member's phone counts as verified only when `profiles.phone_verified = true`. It is set by an `AFTER UPDATE OF phone_confirmed_at ON auth.users` trigger (SECURITY DEFINER) setting `phone_verified = (NEW.phone IS NOT NULL AND NEW.phone <> '' AND NEW.phone_confirmed_at IS NOT NULL)` (false otherwise) and mirroring `phone` into `profiles.phone_verified`/`phone_e164`. Unverified phones never match (prevents claiming someone else's number).
- **Honest consequence:** the app has no phone-verification flow today (no OTP code in `src/` or gateway), so phone matching finds few members at launch; email matching keeps working. A member phone-verification step is a **separate follow-up plan** (needs an SMS provider decision). The pipeline, normalization and discoverability are built now so it lights up as phones get verified.
- **Existing raw matchers hardened** (same migration): `match_existing_contacts()` (trigger `on_phone_verified`) currently links `contacts.contact_phone = profiles.phone` for ANY phone, unverified. Rewrite it to fire on `phone_verified`/`phone_e164` change and match `NEW.phone_e164 = ANY(contact_phone_e164)` only when `phone_verified AND discoverable_by_phone`, excluding test/service accounts. `check_phone_on_platform` (flagged as PII-enumeration risk) gets the same verified + discoverable condition.
- Match at import: email (existing) **or** any E.164 equals a verified, discoverable member's `phone_e164`. Keep test/service exclusion. Client never receives non-matching members.
- Keep the existing route `POST /api/v1/connected-apps/android-contacts/import` (no alias, no rename); extend its body with optional `source: 'picker'|'vcf'|'native'` (stored in `metadata.import_method`; DB `source` stays `android`→ renamed label "Phone" in UI only). Add `DELETE /api/v1/connected-apps/android-contacts` (removes imported device contacts, uses existing `removeImportedContacts`).
- Rollback: migration only adds columns/indexes and replaces two function bodies; a down-migration restores the previous function bodies. Frontend (VTID B) only calls new behaviour behind response fields that are optional, so A on staging without B is safe.

### 3.2 Frontend — one-tap flow (vitana-v1)
- `useContactSync`: `autoSource()` selecting native → picker → fallback screen; vCard parser (`src/lib/vcard.ts`, FN/N/TEL/EMAIL, v2.1/3.0/4.0, quoted-printable) feeding the same endpoint; applies the 5000 cap client-side before POST and tells the user when it truncated; file size limit 10 MB.
- `ContactSyncModal`: new default step order consent → import → results; source grid behind "More sources". Wire `handleConnect` to open DM; replace TODO invite with per-row invite actions.
- `src/lib/contact-invite-links.ts`: builds wa.me/sms/mailto/share URLs from the personal link (`/api/v1/invites/me`, cached) + localized message (i18n key, du-form DE).
- `useContacts.addContact`: remove the client-side raw `profiles.phone` lookup (lines 307-318) — matching happens only on the gateway; fix its hardcoded English toasts; batch the avatar fallback (N+1 at 100-113) and drop debug `console.log`s.
- `useContacts.inviteContact`: only marks `invite_sent_at` after the share/URL was actually opened; toast copy "Invite ready in WhatsApp" etc. Fix every i18n violation in `InviteFriends.tsx` (raw toasts at 85, 89, 196; raw `description` at 215) and route its "Send" through the same helper; `/invite` page reuses the modal flow.
- Settings → Privacy: toggle "People who have my number can find me" (`discoverable_by_phone`).
- All strings DE first, mirrored to 10 locales; RTL-safe (logical properties).

### 3.3 What's New
New finished feature → add `src/whats-new/entries/contacts-find-friends.json` (EN + DE) in the final PR.

### 3.4 Native one-tap (no picker) — deferred, tracked
True WhatsApp-style "read all contacts with one permission prompt" needs native code. Appilix does not provide it. Add a bridge contract `window.vitanaNative?.contacts.getAll()` now (no-op when absent) and add `expo-contacts` to the Native App plan (`docs/programs/native-app/NATIVE-APP-PLAN.md`) as a requirement. Also ask Appilix support whether a contacts plugin exists (owner action, optional).

## 4. Out of scope
Server-sent SMS/email invites; continuous background sync; "X from your contacts joined" pushes (possible follow-up plan); WhatsApp contact import (no API).

## 5. Privacy / GDPR
Consent card states upload purpose; contacts stored only for the importing user (existing RLS); one-tap delete; non-members are never contacted by Vitanaland; discoverability opt-out; no full address book is returned to other users.

## 6. Test plan
- Gateway Jest: rewritten `match_existing_contacts` semantics (SQL test via pg-mem or migration test pattern used in repo), E.164 normalization (DE/AT/RS/US, `0`-prefixed national, `00`, spaces), verified-only matching, discoverable=false excluded, test/service excluded, cap, delete route.
- Vitest: vCard parser fixtures (iOS export, Google export, v2.1 QP), `autoSource()` per environment, invite URL builder (encoding, E.164 for wa.me), modal step flow, `inviteContact` marks only after open, registry/i18n tests.
- Staging (read-only Playwright, `docs/validation/<VTID>/staging-tests.json`): sign in, open Messages → Contacts, button visible, modal opens to consent / fallback screen on desktop Chromium, Contacts tab sections render from existing data; no import executed (write) on staging.
- Visual check desktop 1400×900 + mobile 390×844, LTR + RTL (ar).

## 7. Delivery
Two VTIDs: (A) gateway phone matching + migration + device-contacts route (vitana-platform); (B) frontend one-tap flow + real invites + vCard (vitana-v1), merged after A is on staging.

<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED — concrete mechanism: `profiles.phone_verified` mirrored from `auth.users.phone_confirmed_at` by trigger; no auth query from the importer. Also stated that no verification flow exists today and that verification is a separate follow-up plan.
- F2 [major] ACCEPTED — audited body (`vitana-v1/supabase/migrations/20251010130129_…sql:79-105`): raw `contact_phone = NEW.phone`, unverified. Rewritten in the same migration to E.164 + verified + discoverable + test/service exclusion; `check_phone_on_platform` hardened the same way.
- F3 [major] ACCEPTED — `addContact` client-side match removed; toasts fixed; in scope.
- F4 [major] ACCEPTED — all `InviteFriends.tsx` violations in scope.
- F5 [minor] ACCEPTED — option (a): gateway normalizes and returns/stores E.164; no frontend library.
- F6 [minor] ACCEPTED — N+1 batched and debug logs removed since the file is touched anyway.
- F7 [minor] ACCEPTED — no new route/alias; existing `android-contacts/import` extended; DELETE added on the same path.
- F8 [minor] ACCEPTED — client-side 5000 cap + 10 MB file limit + truncation notice.
- F9 [blocker] ACCEPTED — migration is metadata-only (constant defaults, no backfill); `phone_e164` backfill is a separate batched script; rollback described.
- Q4 — answered in §3.1 "Rollback".

## Round 2 — partner verdict: CONVERGED (F1–F9 closed)
- F10 [minor] ACCEPTED — trigger body requires non-empty `phone` AND `phone_confirmed_at`, else false.
- F11 [minor] ACCEPTED — migration location stated (vitana-platform).
