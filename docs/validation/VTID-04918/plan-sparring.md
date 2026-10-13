# Plan Sparring record — Calendar as the hub of Vitanaland

- **VTIDs (one plan, five phases):** VTID-04914 (Phase 0), VTID-04915 (Phase 1), VTID-04916 (Phase 2), VTID-04917 (Phase 3), VTID-04918 (Phase 4)
- **Change class:** standard
- **Plan hash** (sha256 of the text between the plan markers): `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`
- **Sparring sessions** (`plan_sparring_sessions`, trust tier `attested`, verdict `converged`): P0 `4661f87b-a8e3-405e-b86b-20cf07ad6d94`, P1 `d1615372-7716-4133-b441-ff95fb8b84fa`, P2 `ffd969da-5fa6-4966-8c99-6ab143914be4`, P3 `002dc23a-e6a4-4d41-b157-0290c251920e`, P4 `e9fbe056-4c5c-4ea0-b3a1-37d48361366b`
- **Verdict:** CONVERGED after 3 rounds; nothing disputed
- **Owner approval:** 2026-10-06 in the Claude Code session ("1 Yes, approved"; decisions 2a turn on Google Sync, 2b activate for production, 2c retire older Reminder). The binding exafy_admin approval click (`POST /api/v1/plans/spar/:id/approve`) is pending; until then the ledger gate (log mode) records each sparring id as `sparring_id_unverified` (`not_human_approved`).

---

# Plan — Calendar as the hub of Vitanaland (wire calendar ↔ feed, events, live rooms, messenger, audiobook, Vitana Index, Vitana assistant)

Repos: exafyltd/vitana-v1 (FE), exafyltd/vitana-platform (GW = services/gateway/src, MIG-P = supabase/migrations)
Research base: v1 @ 910a91c, platform @ 393e3b41.

<!-- plan:begin -->

## Change class
**standard** (migrations, new gateway routes, ORB tools, new FE route). Delivered as 5 PRs / 5 VTIDs (one per phase, Phase 0–4), in order. Each phase ships independently and is staging-verified before the next.

## Scope
- FE: `src/pages/Calendar.tsx`, `src/components/calendar/vcal/*` (EntryScreen, new ShareToFeedSheet, InviteSheet), `src/App.tsx` (one route), `src/navigation/registry/screens.json`, `src/hooks/useEventParticipation.ts`, `src/components/meetups/MeetupDetailsDrawer.tsx`, feed card renderer (`useAllNewsFeed` + post card), `MessageBubble` (link/event card), `src/lib/notification-types.ts`, `src/lib/calendar-window-client.ts`, i18n `de/en/es/sr/ar` calendar + feed shards, `src/whats-new/entries/`.
- GW: `routes/calendar.ts`, `services/calendar-producers.ts`, `routes/chat.ts` + `routes/chat-groups.ts` (allow-list), new `services/calendar-share.ts`, `orb/live/tools/live-tool-catalog.ts`, `routes/orb-live.ts` handlers, `services/vitana-brain.ts` (text tools), `services/orb-tools/*`, `services/guided-journey/*` (audiobook reminder), `services/agents/orb-agent/src/orb_agent/tools.py`, `kb/instruction-manual/maxina/12-utility/calendar.md`.
- DB, by owning repo: **vitana-v1 `supabase/migrations`** — `profile_posts` attachment columns + the `trg_notify_community_post` change (both tables' schema lives there). **vitana-platform `supabase/migrations`** — calendar producer triggers on `global_community_events` (same home as the existing VTID-04321 RSVP calendar trigger on `global_event_participants`) and the `calendar_events.source_type` CHECK; `DATABASE_SCHEMA.md`.

## What exists (verified) vs what is missing

| System | Today | Gap |
|---|---|---|
| Calendar core | GW `/api/v1/calendar/*` CRUD/window/move/complete, producer contract `(user_id, source_ref_type, source_ref_id)`, reminders, ICS feed, Outlook/iCloud push; `/calendar` screen | Entry screen has no edit/delete/share/invite/join. Legacy popup still writes Supabase directly. Dead code: `AutopilotCalendarSuggestions.tsx`, `PendingCalendarEventProcessor.tsx`. `event_reminder` deep link `/calendar/{id}` has no route (404). |
| Community events | RSVP → calendar via DB trigger `trg_event_participation_calendar` (+ dedupe trigger) | FE still writes its own `manual` row on join (redundant). Host gets no entry on create. Event time change does not move attendees' entries. Entry → event link goes to the generic list. |
| Live rooms | `live_room_sessions` / `live_room_access_grants` triggers write host + ticket-holder entries | Entry screen has no "Join room" action, no share. |
| News feed | `profile_posts` insert from FE, `trg_notify_community_post` fans out to the tenant | **No way to post from the calendar. Posts cannot carry an event card.** No "share to feed" anywhere. |
| Messenger | `calendar_invite` card works in the tenant/global chat | Community DMs + groups reject it (`chat.ts:73` allow-list). Recipient's accept does not RSVP to the real event. |
| Audiobook | Separate daily reminder (`user_guided_journey_state.metadata.audiobook_reminder`) | Not visible in the calendar. |
| Vitana Index | Completing an entry recomputes the Index and returns `per_pillar_delta` | Delta is not shown to the member. |
| Vitana assistant | Live: search/create/reschedule/cancel/complete/free-slot/conflicts, rsvp, schedule_live_session | No "share my event to the feed" / "invite X". Text chat is read-only (`search_calendar` only). LiveKit agent maps `get_schedule`/`add_to_calendar` differently from the gateway and its `create_calendar_event` skips the write guard. Stale names in `assistant-role-registry.ts:115`. |

## Owner decisions 2026-10-06 (after approval of the sparred plan)
(1) plan approved; (2a) turn on Google two-way sync; (2b) activate the calendar flags for production; (2c) retire the older reminders popup. The decisions are not re-argued; below is how they are implemented.

## Phase 0 — Calendar flags for production + Google sync switch (PR 0, vitana-platform, infra; own VTID)
Facts (verified 2026-10-06):
- Prod `AWS-PROD-DEPLOY-GATEWAY.yml` pins neither `CALENDAR_DEFAULT_REMINDERS_ENABLED` nor `CALENDAR_MAINTENANCE_ENABLED`; only `AWS-STAGE-DEPLOY-GATEWAY.yml:1101-1102` pins them. Prod env comes from the live prod task def (not readable from this session: no AWS CLI).
- Staging already runs both loops **against the shared production database**, so reminder rows for real members are already materialized and dispatched by staging today. The reminder upsert is idempotent (`calendar-reminders.ts:438`, `on_conflict=calendar_event_id,calendar_occurrence_start,reminder_offset_minutes`) and the dispatch claim uses SKIP LOCKED, so a second reconciler in prod adds redundancy, not duplicates.
- Google sync needs `CALENDAR_GOOGLE_SYNC_ENABLED=true` **and** `GOOGLE_OAUTH_CLIENT_ID/SECRET`. Staging `GET /api/v1/social-accounts/providers` (read 2026-10-06) reports `google: configured:false`: **no Google OAuth client exists on any environment**. Creating it is operator-only (Google Cloud Console project, not `lovable-vitana-vers1` and not the Vertex bridge project; Calendar API enabled; consent screen with `calendar.app.created` + `calendar.freebusy`; redirect URIs for staging + prod; `scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging|prod provision --apply`, since no Claude session has `secretsmanager:CreateSecret`). Until Google verifies the app, only listed test users can connect.

Changes:
1. **Prod workflow**: new step "Build task-definition (calendar gates)" (own step, same pattern as the VTID-04824 Jev step, to stay under the 20,000-char run limit) pinning `CALENDAR_DEFAULT_REMINDERS_ENABLED=true`, `CALENDAR_MAINTENANCE_ENABLED=true`, `CALENDAR_GOOGLE_SYNC_ENABLED=true`.
2. **Prod Google OAuth wiring**: the prod deploy role has no `secretsmanager:Describe*`, so secrets are wired from repository variables holding the full ARNs (`PROD_GOOGLE_OAUTH_CLIENT_ID_ARN`, `PROD_GOOGLE_OAUTH_CLIENT_SECRET_ARN`). Empty variable → not wired (never a dangling `valueFrom`, which would stop new prod tasks from starting). The operator sets the variables after provisioning.
3. **Staging workflow**: pin `CALENDAR_GOOGLE_SYNC_ENABLED=true` (the secrets are already resolved there when present).
4. With the flag on and no client, the sync reports `not_configured` (`calendar-google-sync.ts:44-45`) and the FE card says "not available yet". This is safe and lights up as soon as the operator provisions.
5. Workflow-suite Jest test asserting the three pins and the empty-variable no-wire behaviour; `docs/CONNECTED-APPS-OAUTH-SETUP.md` updated with the prod section.
6. Reaches prod only through the Staging Verification Gate. The ready message lists every commit between prod and the verified commit; for a flags-only promotion, `env-only` mode is used so no unrelated app code ships.
7. **Operator handoff (not doable from a session)**: the Google OAuth client plus secrets plus the 2 repo variables, then Google app verification. Reported to the owner as a blocker with exact steps; not routed around.

## Phase 1 — Repair the base (PR 1)
1. **Entry deep link.** Add route `/calendar/entry/:id` (plain path, no query — the Android wrapper drops query strings on push) that opens `/calendar` with that entry's `EntryScreen`. Add to `screens.json` as a sub-screen of `CALENDAR.OVERVIEW` (or `exclusions.json` with reason "deep link target, not voice-navigable"). Point `event_reminder` and `upcoming_event_today` at it.
2. **Entry actions on `EntryScreen`** via existing GW endpoints: Edit (PATCH `/events/:id`) only for `manual|invite`; `assistant` entries get Move + Delete only (no free edit), so an assistant-created entry is never silently rewritten into something else; Delete/cancel (DELETE) for `manual|invite|assistant`. For producer-owned sources (`community_rsvp`, `live_room`, `autopilot`, `goal_plan`, `health_plan`, `lab_order`, `appointment`) Edit is replaced by "Open source" (event drawer by `source_ref_id`, live room view, autopilot, plan).
3. **Source-aware primary action** (one per entry): community event → "Open event" (opens `MeetupDetailsDrawer` for that event id in-app; today the link only goes to the generic `/comm/events-meetups` list); live room → "Join room" enabled from `lobby_open_at`; autopilot/goal → "Mark done" (exists).
4. **Show the Index delta** returned by `/complete` (`per_pillar_delta`) as a small confirmation on the entry ("+0.4 Mental").
5. **Remove the redundant FE calendar writes** on RSVP (`useEventParticipation.ts:181`, `MeetupDetailsDrawer.tsx:573` "add to Vitana calendar" becomes a no-op state "In your calendar" because the trigger already did it). Keep the external Google/Outlook/ICS exports.
6a. **Retire the older reminders popup** (`EnhancedCalendarPopup` + `MobileCalendarModal` and the children only they use: `WeekGridView`, `EventDetailsPanel`, `CalendarFilters`, `CalendarSkeleton`, `BookedVitanaEventsSection`, `NaturalLanguageInput` + `parseCalendarNL.ts` (its golden test `calendar-logic.golden.test.ts` is removed for the NL parser part and kept for anything still live), `calendarSmartUtils.ts` (all of its consumers go), `SmartEventCard`, `TodayFocusStrip`, `JourneyProgressStrip`, `OnboardingPlanCard`, `AutopilotTaskGroup`; each confirmed unused by a grep before deletion; shared utils stay):
   - `calendar:open {tab:'reminders'}` (`UniversalCalendarButton.tsx:39`, `MobileAppShell.tsx:33`) navigates to `/reminders` instead of opening the popup; `opensRemindersPopup` is renamed to `opensReminders`.
   - `pages/Reminders.tsx` renders the standalone `RemindersPanel` page on every viewport. The mobile/`fire` overlay branch that mounted the popup is removed. The fire flow (`/reminders/fire/:fireId`, push deep link) is unchanged: `ReminderInterruptOverlay` still handles the fire. A regression test pins that `/reminders/fire/:id` renders the panel and does not navigate away.
   - `/calendar`'s `RemindersSection` gets a "All reminders" link to `/reminders`.
   - `calendar-entry.test.ts` and `__regression__` updated; the existing assertion that the popup is not used becomes "the component no longer exists".
   - Legacy `useCalendarEvents` stays (messenger invites, `SmartCalendarCard`, `useJourneyProgress` still use it). Only the popup UI is retired.
6. **Delete dead code**: `AutopilotCalendarSuggestions.tsx`, `PendingCalendarEventProcessor.tsx` + `calendarPendingQueue.ts` (+ its `AppLayout` mount), `void nextUp`.
7. **Events DB gaps (vitana-platform migrations)**: trigger on `global_community_events` INSERT → host entry via the in-database SQL `calendar_upsert_from_source` (`source_ref_type='community_event'`); UPDATE OF `start_time, end_time, location, title` (WHEN columns actually changed) → **one set-based `UPDATE calendar_events … WHERE source_ref_type='community_event' AND source_ref_id=NEW.id AND status<>'cancelled'`** for host + all attendees (pure SQL, no network calls, no per-row loop; same pattern as the live-room trigger); status cancelled → one set-based cancel. Reminder rows follow via the existing reconcile. Backfill hosts of future events in the migration.

## Phase 2 — Post to the news feed from the calendar (PR 2, the headline)
1. **DB (vitana-v1 migrations):** `profile_posts` add `attached_ref_type text NULL CHECK (attached_ref_type IN ('community_event','live_room_session'))`, `attached_ref_id uuid NULL`, both-or-neither CHECK, partial unique index `(user_id, attached_ref_type, attached_ref_id)` — **one share per member per event** (prevents tenant-wide notification spam; re-share = edit the existing post). **Notification amplification guard:** `trg_notify_community_post` is changed so that for posts with `attached_ref_id` it inserts type `community_event_shared` (new catalog entry, EN/DE via `tt()`) and **skips any recipient who already got a `community_event_shared` notification for the same `attached_ref_id` in the last 24 h** (NOT EXISTS backed by a partial functional index created in the same migration: `CREATE INDEX … ON user_notifications (user_id, (data->>'ref_id'), created_at) WHERE type = 'community_event_shared'`). Plain posts keep today's behaviour unchanged. Plus endpoint rate limit: max 5 event shares per member per 24 h (429). Worst case per recipient: 1 push per event per day, regardless of how many members share it.
2. **GW:** `POST /api/v1/calendar/events/:id/share-to-feed` (`services/calendar-share.ts`), body `{ text, is_public }`. Server rules:
   - `user_id` of the post is taken **only from the verified JWT** (`req.identity.user_id`), never from the body; the body has no user field and extra fields are rejected. Gateway uses service role, so this is the ownership check RLS would otherwise do — a Jest test proves a spoofed id in the body is ignored/rejected.
   - entry must belong to the caller and be **shareable**: only `source_ref_type IN ('community_event','live_room_session')` and the underlying event/session is public, not cancelled, not in the past. **Never** shareable: health_plan, lab_order, appointment, goal_plan, journey, autopilot, manual, external busy (health/privacy).
   - resolves the canonical event id from the entry's source ref (never trusts client ids), inserts `profile_posts` with attached ref; 409 `ALREADY_SHARED` returns the existing post id.
   - text is the member's own text (max length as feed composer); empty text allowed → card only.
   - emits OASIS event `calendar.shared_to_feed`.
   - `GET /events/window` items get `shareable: boolean` and `shared_post_id`.
3. **FE:**
   - `ShareToFeedSheet` from EntryScreen's "Share" (and from `MeetupDetailsDrawer` / `LiveRoomDrawer` for attendees — same endpoint via the member's entry). Prefilled editable text from the i18n catalog (`screens.calendar.share.default_going` = "Ich bin dabei: {title} – {date}. Kommst du mit?" du-form; dates via `fmtDate`/`fmtTime`), audience toggle (public / only me = draft not allowed → just public/private), preview of the card.
   - **Event attachment card** in the feed post renderer (`useAllNewsFeed` row → `EventAttachmentCard`): title, date/time (locale helpers), location/online, attendee count, cover; CTA "I'm in too" → existing RSVP path (DB trigger adds the viewer's calendar entry) or "Join room"/"Notify me" for live sessions; tap → event drawer. Card reads the live event so a moved/cancelled event shows its current state ("Cancelled" badge, CTA hidden).
   - After share: toast + entry shows "Shared to feed" with link to the post.
   - RTL: logical properties only.
4. **What's New entry** `calendar-share-to-feed.json` (EN + DE, path `/calendar`).

## Phase 3 — Messenger, audiobook (PR 3)
1. **Invite from calendar to chat:** EntryScreen "Invite" → pick DM/group → sends a **typed card**. GW: allow `calendar_invite` in `chat.ts` and `chat-groups.ts` allow-lists with a validated `metadata { ref_type, ref_id }` (server checks ref is a public community event / live session or the sender's own manual entry). Recipient taps Accept → for event refs, RSVP through the existing participation path (trigger creates their entry); for a manual entry, `upsertCalendarEntryFromSource(source_ref_type='calendar_invite', source_ref_id=<message_id>)`. Decline/Maybe stored in `calendar_invite_responses` as today. `MessageBubble` renders the card for community DMs (also render existing `link_share` event URLs as the same card — no new type).
2. **Audiobook in the calendar:** when the member sets/changes/clears the audiobook daily reminder, GW calls `upsertCalendarEntryFromSource` (single row, `source_ref_type='audiobook_reminder'`, `source_ref_id=<user_id>`, `rrule='FREQ=DAILY'`, `timezone=<tz>`) / `cancelCalendarEntriesForSource`. Expansion is already bounded by the requested window plus `calendar-recurrence.ts` caps (`limit` 500, `MAX_ITERATIONS` 5000), so no UNTIL is needed. Migration adds `audiobook` to the `source_type` CHECK. Entry has `reminder_offsets = []` so the calendar reminder loop does **not** double-push (the audiobook dispatcher stays the single sender). Primary action "Listen now" → `/autopilot/audiobook`. Listening is tracked by the player (`/session-listened`), not by marking the calendar entry done; the entry is informational with no "Mark done".

## Phase 4 — Vitana assistant parity (PR 4)
**One implementation for all three assistant paths:** calendar write tools are added to the shared `ORB_TOOL_REGISTRY` (`orb-tools-shared.ts`) behind the shared `POST /api/v1/orb/tool` dispatcher (`routes/orb-tool.ts`, `requireAuth`), which the LiveKit agent already uses for its other tools. The guard parts that are request-checkable — `confirmed === true` and a non-past start — move into the shared handler, so they hold for gateway-live, LiveKit and text alike. `memberHasSpoken` stays enforced in the gateway live session (only it has that state); the LiveKit and text paths are turn-driven by a member utterance by construction.
1. New tools: `share_calendar_entry_to_feed { entry_id | event query, text?, confirmed }` and `invite_to_calendar_entry { entry_id, recipient, confirmed }`, calling the Phase 2/3 GW services. The assistant composes the post text in the member's language (locale via `getUserLocale`), reads it back, and posts only after explicit yes. Spoken wording is model-composed (rule 41), not hardcoded.
2. Text chat (`vitana-brain.ts`): add `create_calendar_event`, `reschedule_event`, `cancel_event`, `share_calendar_entry_to_feed` with the same guard.
3. LiveKit agent `tools.py`: align `get_schedule`/`add_to_calendar` with the gateway meaning (external calendars) and replace the raw `POST /api/v1/calendar/events` in `create_calendar_event` (`tools.py:721-726`) with the shared `/api/v1/orb/tool` dispatch, so the shared guard applies.
4. Remove stale `get_calendar_today/week` from `assistant-role-registry.ts:116-117`.
5. Update `kb/instruction-manual/maxina/12-utility/calendar.md` (share, invite, audiobook, join).

## Phase dependencies and order
PR0 (independent, may run in parallel with PR1) and PR1 → PR2 → PR3 → PR4, each merged only after the previous one's STAGING-VERIFY passed. PR2 does not need PR1's trigger for attendee shares, and PR1's host backfill is live before PR2 merges, so hosts can share too; (RSVP and live-room entries already carry `source_ref_type`), PR3 does not need PR2. PR4 calls PR2+PR3 services, so it is last. Each PR's migrations are applied as part of that PR's deploy before its staging suite runs.

## Verification (every phase)
- **No production writes, no test posts anywhere** (posts fan out to the whole tenant). All write paths proven with gateway Jest (in-memory/mocked PostgREST: shareable rules, ownership, 409 duplicate, privacy denylist, allow-list validation, audiobook no-double-reminder) and FE Vitest (sheet, card states, RTL render).
- `CALENDAR-REGRESSION` suite + v1 `__regression__` extended; `npm test` (nav registry), `npm run lint` (i18n rules), `npm run build`, `npm run i18n:inventory`.
- `docs/validation/<VTID>/staging-tests.json` per phase: read-only Playwright on `preview-aws.vitanaland.com` — opens `/calendar/entry/:id` for an existing entry, sees actions, opens Share sheet and Invite sheet **without submitting**, renders an existing feed post with attachment once one exists naturally (else Vitest fixture only).
- Visual check (desktop 1400×900, mobile 390×844, plus `ar` RTL) of changed screens on staging.

## Out of scope
- Calendar embeddings / `semantic_calendar_search` (dead, separate).

<!-- plan:end -->

---
## Planner responses — round 1
- **F1 [blocker] migration repo** — ACCEPTED for `profile_posts` (moved to vitana-v1 migrations, together with the notify-trigger change). PARTLY REJECTED for the `global_community_events` calendar trigger: the existing calendar producer trigger on the sibling table `global_event_participants` (VTID-04321) already lives in vitana-platform `supabase/migrations/20260923120000_vtid_04321_rsvp_calendar_global_events.sql`, together with `calendar_upsert_from_source`. Keeping all calendar producer triggers next to that function is the established convention; the trigger only adds behaviour and does not alter the table's schema.
- **F2 [major] wrong producer API** — ACCEPTED. Switched to `upsertCalendarEntryFromSource` with the `rrule` field (it is in the allowed field list, `calendar-producers.ts:70`). No UNTIL is needed: expansion is bounded by the window plus `calendar-recurrence.ts` (`limit` 500, `MAX_ITERATIONS` 5000).
- **F3 [major] LiveKit guard** — ACCEPTED. Calendar write tools move into the shared `ORB_TOOL_REGISTRY` / `POST /api/v1/orb/tool` dispatcher, which the LiveKit agent already uses (`tools.py:126-139`). The request-checkable guard (`confirmed`, non-past start) runs there for all paths. `memberHasSpoken` stays in the live session.
- **F4 [major] notification amplification** — ACCEPTED (option a + c). New type `community_event_shared`, deduplicated per recipient per event per 24 h inside the trigger, plus a limit of 5 shares per member per 24 h on the endpoint.
- **F5 [minor] line ref** — ACCEPTED (`:116-117`).
- **F6 [minor] assistant edit** — ACCEPTED. Free edit only for `manual|invite`; `assistant` entries can only be moved or deleted.
- **F7 [major] ownership with service role** — ACCEPTED. `user_id` comes from the JWT only, the body schema is strict, and a Jest test covers a spoofed id.
- **Q1** — Set-based SQL `UPDATE` inside the trigger (no network calls, no loops), same pattern as the live-room trigger. A few hundred rows per event change is fine.
- **Q2** — `calendar-reminders.ts:91` treats `reminder_offsets = '{}'` as "none" and produces no reminder rows. The reconcile reads the entry once per change, not per tick, so the reminder cron has no per-tick cost.
- **Q3** — Order and dependencies are now stated explicitly in the plan (sequential, each staging-verified; PR4 depends on PR2 and PR3).

## Planner responses — round 2
- **F8 [minor] index** — ACCEPTED. The partial functional index is now named explicitly in the plan.
- **F9 [minor] host backfill before PR2** — ACCEPTED. PR1 (with the backfill) has to be staging-verified before PR2 merges; the plan now says so.

## Verdict: CONVERGED (2 rounds). Round 1: 1 blocker, 4 majors, 2 minors, all closed. Round 2: 2 minors, accepted. Nothing disputed.

## Planner responses — round 3 (owner-decision implementation)
- **F10 [minor] `parseCalendarNL.ts` golden test** — ACCEPTED. The parser's part of the test is removed with it.
- **F11 [minor] `calendarSmartUtils.ts` becomes dead** — ACCEPTED. Added to the deletion list.

## Final verdict: CONVERGED after 3 rounds (standard cap). Blockers and majors: 1 + 4 raised, all closed. Minors: 6, all accepted. Disputed: none. Owner approval: 2026-10-06 in chat ("1 Yes, approved"), plus decisions 2a/2b/2c, which this plan implements.


## Sparring rounds (partner findings verbatim)

Partner: `plan-sparring-partner` (independent, read-only; saw only the plan file and the code). Same partner instance across all three rounds.

### Round 1 — findings

**F1 [blocker] Plan assigns `profile_posts` migration to the wrong repo (`MIG-P` = vitana-platform), but all `profile_posts` schema work lives in vitana-v1.**
Evidence: `profile_posts` was created in `/home/user/vitana-v1/supabase/migrations/20260210135042_9aec11fb-ddef-4e88-b937-0e3c8f87c210.sql:3`. Every subsequent ALTER (`video_url`, `REPLICA IDENTITY`, RLS policies) also lives in `vitana-v1/supabase/migrations/`. Zero `profile_posts` migrations exist in vitana-platform. Phase 2 item 1 says "DB (MIG-P): profile_posts add attached_ref_type..." which targets the platform repo. Splitting a table's schema across two repos that push to the same Supabase project creates ordering hazards and breaks the established convention.
Suggestion: Move the Phase 2 `profile_posts` migration to `vitana-v1/supabase/migrations`. Same for the `global_community_events` trigger in Phase 1 item 7 -- that table was also created in vitana-v1 (`/home/user/vitana-v1/supabase/migrations/20250917153624_22b8e9be-eb29-477c-974b-87a609943321.sql:81`). However, note that `calendar_events` migrations are in the platform repo, so the new `calendar_events` CHECK change (Phase 3, adding `audiobook`) correctly goes to MIG-P.

**F2 [major] Plan misuses `upsertCalendarSeriesFromSource` for the audiobook recurring entry.**
Evidence: Phase 3 says "GW calls `upsertCalendarSeriesFromSource(source_ref_type='audiobook_reminder', rrule='FREQ=DAILY', tz)`". The actual function signature at `/home/user/vitana-platform/services/gateway/src/services/calendar-producers.ts:221-225` is `upsertCalendarSeriesFromSource(userId, series: {source_type, source_ref_type, series_id}, entries: SeriesEntry[])` -- it takes an explicit array of entry objects, not an rrule string. The rrule column is a field on `calendar_events` for gateway-side expansion, stored on a single row. The correct call for a daily recurring reminder is `upsertCalendarEntryFromSource` (singular) with `{ rrule: 'FREQ=DAILY', ... }` on the entry fields, not `upsertCalendarSeriesFromSource`.
Suggestion: Replace with `upsertCalendarEntryFromSource` using the rrule field. Also specify a UNTIL or COUNT on the RRULE to avoid unbounded expansion -- the gateway expands recurring entries in the window query, and an open-ended DAILY rule would expand indefinitely for any window end date. The existing code at line 82-84 of the migration indexes recurring entries separately, but the expansion logic must have a cap.

**F3 [major] Phase 4 LiveKit agent alignment is under-specified and may be architecturally impossible as described.**
Evidence: The plan says "route `create_calendar_event` through the guarded handler instead of raw REST" for the LiveKit agent (`tools.py`). The write guard (`calendar-write-guard.ts` at `/home/user/vitana-platform/services/gateway/src/orb/live/tools/calendar-write-guard.ts:1-30`) is TypeScript, runs in the gateway's live-session context, and checks `memberHasSpoken` and `confirmed` -- state that only exists in the gateway's WebSocket session. The LiveKit agent is Python and calls the gateway over REST (`_gw(context).post("/api/v1/calendar/events", ...)`). It has no access to the TypeScript guard's session state. The plan needs to specify whether the guard moves to the REST route (breaking existing non-voice callers) or becomes a separate guarded REST endpoint, or something else.
Suggestion: Add a dedicated `POST /api/v1/calendar/events/guarded` (or a header/flag on the existing route) that applies the write-guard logic server-side using request metadata (e.g., `X-Orb-Session-Id` to look up session state). Or, since the LiveKit agent already operates within a voice session context, have the Python tool declare `confirmed: bool` and pass it to the gateway, and have the gateway route enforce the guard when the request comes from an orb-agent caller.

**F4 [major] Notification amplification risk from share-to-feed at scale.**
Evidence: `trg_notify_community_post` at `/home/user/vitana-v1/supabase/migrations/20260630120000_notify_on_community_publish.sql:36-45` inserts one notification per tenant member (minus the author) for every `INSERT INTO profile_posts WHERE is_public = true`. The plan says "No change to trg_notify_community_post (a share is a real member post and should notify like one)." For a viral event with 50 members sharing, that produces ~50 x 191 = ~9,550 notifications + pushes, all about the same event. This is the exact "notification spam" pattern the plan's unique index was designed to prevent for an individual, but it does not address the aggregate. CLAUDE.md records the cost of exactly this pattern: 5 test posts became 960 notifications and 600 pushes.
Suggestion: Either (a) introduce a distinct notification type (`community_event_shared`) with per-event deduplication for each recipient (a member gets at most one "X and N others shared Event Y" notification per event per time window), or (b) suppress the trigger for posts that carry an `attached_ref_id` and handle their notification separately (a batched or deduplicated fan-out), or (c) explicitly accept this risk with a documented rationale and a rate-limit mechanism on the share-to-feed endpoint itself.

**F5 [minor] The plan's line reference for stale assistant-role-registry names is off by one.**
Evidence: Plan says `assistant-role-registry.ts:115`; actual location is lines 116-117 at `/home/user/vitana-platform/services/gateway/src/services/intelligence/assistant-role-registry.ts`.
Suggestion: Fix to `:116-117`.

**F6 [minor] Phase 1 item 2 allows editing entries with `source_type='assistant'` but the write guard exists to prevent unconfirmed assistant writes -- editing an assistant-created entry from the FE bypasses the voice session's confirmation logic.**
Evidence: `calendar-write-guard.ts:1-13` explains VTID-04604: the model created entries without the member asking. Phase 1 allows PATCH on `source_type IN ('manual', 'assistant', 'invite')`. An assistant-created entry the member never asked for (a guard failure that was caught, but the entry may exist from before the guard was deployed) becomes editable. This is minor since editing is less harmful than creation, but worth noting.
Suggestion: Consider limiting FE-initiated edits to `source_type IN ('manual', 'invite')` only, or at minimum documenting why `assistant` is included.

**F7 [major] Phase 2 gateway endpoint changes the write pattern for `profile_posts` from FE-only to gateway-mediated, but the plan does not address the RLS INSERT policy that requires `auth.uid() = user_id`.**
Evidence: `/home/user/vitana-v1/supabase/migrations/20260210135042_9aec11fb-ddef-4e88-b937-0e3c8f87c210.sql:33-35`: the INSERT policy checks `auth.uid() = user_id`. The gateway uses `service_role` which bypasses RLS entirely, so the INSERT will succeed -- but the `user_id` must be set by the gateway from the authenticated JWT, never from the request body, to prevent impersonation. The plan says the endpoint body is `{ text, is_public }` with no `user_id`, which is correct, but this should be called out explicitly since `service_role` bypasses all RLS checks including the ownership constraint.
Suggestion: Explicitly state in the plan that the gateway sets `user_id` from the authenticated session JWT, never from the request body. Add a test that proves the endpoint rejects a mismatched user_id.

Questions: (1) set-based vs per-row trigger work on event change; (2) reminder loop cost for `reminder_offsets = []` entries; (3) independence of the phases.
Verdict round 1: NOT CONVERGED.

### Round 2 — partner disposition
F1 closed (profile_posts → vitana-v1; calendar trigger staying in vitana-platform "justified by precedent (VTID-04321's trigger is already there)"). F2, F3, F4, F5, F6, F7 closed.

**F8 [minor] The `NOT EXISTS` deduplication subquery in the modified trigger (Phase 2, line 39) indexes on `user_notifications.data->>'ref_id'`.** JSONB arrow extraction in a subquery inside a trigger that fans out to all tenant members could be slow without a functional index. The plan mentions "one indexed NOT EXISTS" which implies the index is part of the migration, but it should be explicit: `CREATE INDEX ... ON user_notifications ((data->>'ref_id')) WHERE type = 'community_event_shared'`.

**F9 [minor] Phase dependency statement (line 67) says "PR2 does not need PR1's trigger" because RSVP and live-room entries already carry `source_ref_type`.** This is correct for share-to-feed (Phase 2 reads existing entries). However, the host-entry trigger from Phase 1 item 7 means that event hosts who created events before Phase 1 will have no calendar entry to share from. The backfill in Phase 1 covers future events' hosts, and the migration backfill covers existing future events, so this is handled -- just worth confirming the backfill runs before Phase 2's staging tests.

Verdict round 2: CONVERGED.

### Round 3 — owner decisions 2a/2b/2c (implementation only)
Verified: prod workflow pins neither flag; staging runs both loops against the shared database (`REMINDERS_INPROCESS_DISPATCH_ENABLED=true`, line 1100); reminder upsert idempotent (`calendar-reminders.ts:438,441`, `on_conflict` + `resolution=ignore-duplicates`); `not_configured` without client (`calendar-google-sync.ts:43-46`); prod role has no `secretsmanager:Describe*` (line 506); `env-only` mode exists (line 254); `ReminderInterruptOverlay` mounted at app root (`App.tsx:783`); every listed popup child unused outside the popup chain.

**F10 [minor] `parseCalendarNL.ts` is listed for deletion as part of `NaturalLanguageInput` but has an additional consumer: the regression test `calendar-logic.golden.test.ts`.** The plan says "each confirmed unused by a grep before deletion" but the test file imports it directly. Deleting the util requires updating or removing the golden test.

**F11 [minor] `calendarSmartUtils.ts` is not listed for deletion but all its consumers (the popup children) are being removed.** It becomes dead code after the popup retirement. Should be added to the deletion list.

Verdict round 3: CONVERGED -- no new blockers or majors. Three rounds complete (standard cap).
