# VTID-04965 — plan sparring record

- **Plan hash (sha256 of the text between the plan markers):** `25742129a16531c267ece6cdea7b47e4e751d75a4a1145c9462f10545549ce78`
- **Partner:** `plan-sparring-partner` agent (independent, read-only; saw only the plan file)
- **Rounds:** 3 (round 1: F1–F7 + one question; round 2: F8–F10; round 3: no new findings)
- **Verdict:** CONVERGED
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-07 — "Yes do it" (Gate 1). Binding exafy_admin click pending (`POST /api/v1/plans/spar/:id/approve`).

## Final plan

<!-- plan:begin -->
## Findings in the code (all verified read-only)
1. Tapping "Erinnern" (Notify me) in `src/components/liverooms/LiveRoomDrawer.tsx:handleNotifyMe` inserts a `live_stream_subscribers` row and a personal reminder (`useCreateReminder`). Nothing writes `calendar_events`, so the room never appears in the Maxina calendar. Community events solved the same gap with a DB trigger (`trg_event_participation_calendar`, VTID-04321, vitana-platform `supabase/migrations/20260923120000_…`) — client writes were removed on purpose (VTID-04915).
2. The calendar button in the drawer (`handleAddToCalendar`) only offers Google / Outlook / Apple / ICS; there is no "Maxina Kalender" choice and no automatic entry.
3. The host pill (`LiveRoomDrawer.tsx` ~l.358–395, `room.host.name`) is a plain div — no navigation. Profiles open at `/u/:id` (`NewMemberCard.tsx:52`).
4. After visiting a profile and going back, the drawer is gone: on the Events page (`EventsAndMeetups.tsx:676`) a scheduled room card does `setRoomDrawerEvent(event)` — local state only, not in the URL, so a back navigation remounts the page with no drawer. (Live Rooms page `LiveRooms.tsx:236-238` already writes `?live=<id>`, so back works there; Events page has the `?event=<id>` deep-link handler at l.623-642 which already opens the room drawer.)
5. Share: `LiveRoomDrawer.handleShare()` (l.193-203) only shows a toast `toasts.liverooms.share`; the room card uses `SocialShareButton type="live_room"` with `getLiveRoomShareUrl` (`EventsLiveRooms.tsx:295-300`), which uses native share / platform picker.

## Changes
A. Migration (new file in vitana-platform `supabase/migrations/`, idempotent, transactional): `fn_live_stream_subscription_to_calendar()` + trigger `trg_live_stream_subscription_calendar` on `live_stream_subscribers` (AFTER INSERT OR DELETE), SECURITY DEFINER, search_path public:
   - INSERT: read `community_live_streams` (title, description, scheduled_for, duration_minutes, status); skip unless `status='pending' AND scheduled_for > now()`; insert one `calendar_events` row: `event_type 'community'`, `source_type 'live_room'` (already allowed by `valid_source_type`), `source_ref_type 'live_room'`, `source_ref_id <stream id>`, start = scheduled_for, end = start + duration_minutes (default 60 min), location 'Virtual', `status 'confirmed'`, `role_context 'community'`, `ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO UPDATE SET status='confirmed' WHERE status='cancelled'`.
   - DELETE (un-notify): cancel the live row (`status='cancelled'`) for that user + stream.
   - One-time backfill in the same migration: existing subscribers of streams with `status='pending' AND scheduled_for > now()` get their row (so an existing "Erinnert" appears without re-tapping); test/automation accounts (`notification_test_actors`, `service_bot_accounts`) are skipped.
B. `LiveRoomDrawer.tsx`:
   - Host pill (both the viewer and "your room" variants) becomes a button → `navigate('/u/' + room.host.id)`; keyboard accessible, aria-label via i18n; `Follow` button unaffected (stopPropagation).
   - Share buttons (3 places) use `SocialShareButton type="live_room" variant="icon"` with the same data as the card; remove the toast-only `handleShare`.
   - No client calendar write (VTID-04915 pattern). The Erinnern toast now says the entry is in the Maxina calendar (new i18n text, de first, du-form, mirrored to 10 locales); the Google/Outlook/Apple/ICS menu is unchanged.
C. `EventsAndMeetups.tsx`: a scheduled-room card tap pushes `?event=<id>` (keeping `tab`) so the drawer is in history; closing the drawer removes the param; the `roomDeepLinkRef` is reset on close so a later back-navigation reopens it. Back from the profile therefore returns to the Events list with the drawer open at the same room. (Live Rooms page already behaves this way.)
D. Tests: vitest for the drawer (host pill navigates to /u/id; share renders SocialShareButton; Erinnern toast text), Events-page test (card tap sets ?event, close clears it), a trigger-text pinning test in vitana-platform (like VTID-04915's). STAGING-VERIFY spec `docs/validation/<VTID>/staging-tests.json` read-only: sign in, open scheduled room drawer, assert host pill is a link to /u/…, share control is the SocialShareButton, the calendar menu still lists Google/Outlook/Apple/ICS; no writes. The calendar row itself is proven by the platform CI test, not staging (rule 3 of staging gate).
E. What's New: skipped (fix, not a feature) — decision to list at Gate 2.

## Not in scope / deferred
- Rescheduling a room does not update members' calendar rows (follow-up VTID).
- Profile page "back" button behaviour itself (if it uses navigate(-1) it already works once C lands; verify in implementation, change only if it hard-codes a route).

## Risks
- Migration on production Supabase project: applied only through the repo's migration workflow after merge, never by hand (CLAUDE.md absolute rule). Staging uses the same DB, so the trigger is live for staging verification; the read-only spec does not exercise it, a SQL-level test in CI does.
- Test accounts: backfill must skip `notification_test_actors` / `service_bot_accounts` so no automation account gets calendar rows.
<!-- plan:end -->

## Findings and planner responses

Round 1 findings (partner, verbatim summary): F1 major migration belongs in vitana-platform (two PRs); F2 major use `source_type 'live_room'`, not `community_rsvp`; F3 minor file count understated; F4 minor a client-side "Maxina Kalender" write contradicts VTID-04915; F5 minor backfill must require pending + future; F6 minor trigger test belongs in vitana-platform; F7 minor check the share icon fits the action bar. Round 2: F8 major audit must not share this VTID; F9 plan body stale; F10 staging spec referenced a removed UI element. Round 3: all closed, no new findings.

## Planner responses (round 1)
- F1 ACCEPTED — migration goes in exafyltd/vitana-platform/supabase/migrations next to VTID-04321/04915; two PRs (platform: migration + trigger-text test; v1: frontend + i18n + tests). Change class stays standard; file list corrected: 1 migration, 1 platform test, LiveRoomDrawer.tsx, EventsAndMeetups.tsx, 11 i18n shards, v1 tests, staging spec.
- F2 ACCEPTED — verified: `valid_source_type` (20260923130000_vtid_04331…:76-78) contains `live_room`. Trigger writes `source_type='live_room'`, `source_ref_type='live_room'`. No constraint change needed.
- F3 ACCEPTED — scope list corrected as in F1.
- F4 ACCEPTED (option b) — no client write. The "Maxina Kalender" dropdown item is dropped; the trigger makes the entry automatic on "Erinnern". For a member who has not tapped Erinnern, the dropdown item is replaced by nothing; the Erinnern button is the single in-app action, and its toast now says the entry is in the Maxina calendar.
- F5 ACCEPTED — backfill and trigger both require `status='pending' AND scheduled_for > now()`; backfill also skips `notification_test_actors` and `service_bot_accounts`.
- F6 ACCEPTED — trigger-text pinning test lives in vitana-platform; frontend tests in vitana-v1.
- F7 ACCEPTED — before implementing, confirm `SocialShareButton variant="icon"` (p-2, ghost) fits the `shrink-0 w-11` slot; wrap in a w-11 outline container if not; screenshot both viewports.
- Q3 ANSWERED — `community_live_streams.duration_minutes` exists (vitana-v1 migration 20260630130000_live_stream_duration.sql); default 60 min when null.
- (Scope note removed, see round 2.)

## Planner responses (round 2)
- F8 ACCEPTED — the app-wide audit is NOT part of this plan or VTID. It is a separate task that starts after this one merges, with its own plan round; my earlier note calling it an owner decision was wrong (the owner has not decided yet) and is removed.
- F9 ACCEPTED — plan body updated: `live_room` source type, no Maxina dropdown item, platform/v1 file split, explicit pending+future filter and test-account exclusion.
- F10 ACCEPTED — staging spec now asserts host link, share control, and the unchanged Google/Outlook/Apple/ICS menu; the calendar row is proven by the platform CI trigger test.
