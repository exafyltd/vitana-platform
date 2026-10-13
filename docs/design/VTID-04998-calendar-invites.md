# VTID-04998 — Shared calendar events and invites (design)

Status: design for owner decision at Gate 1 (approved 2026-10-12). Phase 1 shipped under VTID-05104 (invite guards and fixes, no schema change); phases 2 onward are still design only.
Repos read: `vitana-platform` (GW = `services/gateway/src`) and `vitana-v1` (v1 = `src`, read-only).
Commit read: platform `origin/main` cc899c631.

## 0. Correction to the approved plan (read first)

Plan fact C6 says there is "no member-to-member invite creation, no accept/decline route". That is out of date. **VTID-04917 (messenger invites) already shipped a first, chat-based invite flow**:

- `GW/services/calendar-invite.ts` builds the invite card server-side from the sender's own entry (`buildInviteFromEntry`, :74-123), stores it as a `chat_messages` row of type `calendar_invite` (`GW/routes/chat.ts:63-90` DM, `GW/routes/chat-groups.ts:281` group), and handles the answer (`respondToInvite`, :242-314): `POST /api/v1/calendar/invites/:messageId/respond` (`GW/routes/calendar.ts:944`), `GET /invites/:messageId` (:929), `GET /events/:id/invite-preview` (:913).
- Answers are stored in `calendar_invite_responses (message_id, user_id, response accepted|declined|maybe|pending)`, unique `(message_id, user_id)` (vitana-v1 `supabase/migrations/20250923103450_*.sql:32-41`, created in the v1 repo, not in platform migrations).
- Accept on an own-entry invite writes a **per-member copy** in the recipient's calendar: `source_type='invite'`, `source_ref_type='calendar_invite'`, `source_ref_id=<message id>` (`calendar-invite.ts:283-297`). Decline cancels it. Community events and live rooms are joined through the existing `global_event_participants` trigger path (:316-334).
- A voice tool `send_calendar_invite_in_chat` (`GW/services/orb-tools/messaging-depth-tools.ts:723-855`) sends the same message type.

What is still true: no attendee model, no edit/cancel propagation, no organizer view beyond counts, and no real "shared event". VTID-04998 is therefore **the second step on top of the messenger invite**, not a greenfield build. Two defects found while verifying (see section 10) should be fixed first or in step 1.

## 1. Goal and non-goals

Goal: a member can invite other members to an event of their own; invitees answer yes / maybe / no; the event stays in sync (time, place, cancel) for everyone who said yes or maybe; each person sees only what the privacy model allows.

Non-goals (this VTID): inviting non-members by email/link; recurring shared events; group-wide "everyone in this group is invited" auto-membership; public events (the community event system already covers those); suggesting a time that fits all attendees (later phase, section 8); resource/room booking; sharing health-plan, lab, appointment or reminder entries (they stay uninvitable, `calendar-invite.ts:33-42`).

## 2. Current state (evidence)

| Fact | Evidence |
|---|---|
| `invite` is a source_type value | `GW/types/calendar.ts:216-223`; CHECK in `supabase/migrations/20261010100000_vtid_04997_test_results_in_calendar.sql:34` (newest, same list also in 04978/04994) |
| One row per member, unique `(user_id, source_ref_id, source_ref_type)` where `source_ref_id` is not null | `supabase/migrations/20260413000000_intelligent_calendar.sql:111-113` |
| Only own one-off `manual`/`invite` entries are invitable, never recurring | `calendar-invite.ts:33,106-109` |
| Accepted copy is a plain copy; no link back to the organizer's entry (only `metadata.invited_by`, `message_id`) | `calendar-invite.ts:283-297` |
| Edit/cancel of the organizer's entry does not touch copies; the card in chat keeps the old title/time | `PATCH /events/:id` `GW/routes/calendar.ts:701`, `DELETE :973` have no invite logic |
| Recipient can edit or remove the copy locally | v1 `components/calendar/vcal/entry-actions.ts:36-54` (`EDITABLE_SOURCES`, `REMOVABLE_SOURCES` include `invite`) |
| Share-to-feed only, not invites | `GW/services/calendar-share.ts` (`checkShareTarget`, `shareRefOf`) |
| Community events/RSVP is trigger-connected | `supabase/migrations/20260923120000_vtid_04321_rsvp_calendar_global_events.sql:96-97` (`trg_event_participation_calendar`), `20261006140000_vtid_04915_*` |
| Chat DM send checks only auth + tenant (`requireTenant`) and "not yourself"; **no block, connection, test-account or rate check** | `GW/routes/chat.ts:55-75`. The voice path has a send quota (`checkVoiceSendQuota`, `voice-message-guard.ts`), the app path does not |
| No member block/mute table and no friend/connection model for DMs found in platform or v1 migrations (searched for blocks/mutes/friends/connections; `follows` exists for live-room hosts, 04976, and profiles have follow lists in v1) | grep of both migration trees |
| Test/service allowlists exist as tables only; DB guard drops notifications whose actor is a test actor | `service_bot_accounts` (`20260917084341_vtid_03990_*`), `notification_test_actors` (v1 migration `20260805160000`, CLAUDE.md v1) |
| Reminders honor quiet hours via `user_notification_preferences.dnd_*`; explicit `reminder_offsets` ignore them | `GW/services/calendar-reminders.ts:108-150,234-247` |
| Conflict and free-slot services read the member's own window, recurrence and external busy | `calendar-service.ts:259-273 findConflicts`, `:457-475 findFreeSlots`, `computeConflicts :216`, `computeFreeSlots :359`; routes `GET /conflicts`, find-a-time (VTID-04995/04996) |
| Gateway uses the service role, so RLS does not protect these paths | `getSupabaseConfig()/headers()` in `calendar-service.ts` and `calendar-invite.ts:55-61`; `calendar_invite_responses` RLS (v1 `20250925155007_*`) only lets the sender SELECT and refers to the legacy `messages` tables, so it protects nothing here |
| Account deletion already purges `calendar_invite_responses` by user_id | `supabase/functions/request-account-deletion/index.ts:38` |

## 3. Data model options

### Option A — one organizer row plus attendee rows (`calendar_event_attendees`)
The organizer's `calendar_events` row is the only event. New table `calendar_event_attendees (event_id, user_id, response, invited_by, invited_at, responded_at, hidden_from_others)`, unique `(event_id, user_id)`. Invitees do not get a `calendar_events` row of their own; the calendar window reads attendee rows and renders the organizer's event for them.
- Edit/cancel propagation: automatic and free, one source of truth.
- Privacy: weak spot. Every read path (window, ICS feed, Google push, reminders, conflicts, assistant tools) that selects `calendar_events WHERE user_id = me` must be changed to also join attendees. Missing one leaks nothing but silently omits the event; changing access rules inside `listCalendarWindow` puts the organizer's row in other members' queries, so one forgotten owner filter becomes a data leak.
- Per-member overrides (own reminder, own colour, own note, "done") need a second table anyway.
- Unique index: unaffected, but `idx_calendar_events_source_ref` becomes irrelevant for invitees.
- Cost: high. Reminders, ICS, Google sync, conflicts, find-a-time, work lens, assistant tools all assume "a member's events are rows with their user_id".

### Option B — per-member copies linked by a shared event id (recommended)
Keep today's model (it already ships in 04917): every member who accepts has their own `calendar_events` row. Add a **shared-event identity** and an attendee ledger:
- `calendar_shared_events (id, organizer_id, tenant_id, title, description, start_time, end_time, location, timezone, status active|cancelled, version int, created_at, updated_at)`. The canonical content.
- `calendar_shared_event_members (shared_event_id, user_id, role organizer|invitee, response invited|accepted|maybe|declined|left|removed, invited_by, invited_at, responded_at, show_to_others bool, calendar_event_id)`; unique `(shared_event_id, user_id)`. This subsumes `calendar_invite_responses` for the new flow.
- Each accepted member's calendar row: `source_type='invite'` (organizer keeps `manual`), `source_ref_type='shared_event'`, `source_ref_id=<shared_event_id>`. This **fits the existing unique index** `(user_id, source_ref_id, source_ref_type)`: one row per member per shared event, idempotent upsert via `upsertCalendarEntryFromSource` (already used at `calendar-invite.ts:283`). The messenger flow keeps its `calendar_invite` + message id key; a migration step maps old ones lazily (an old accepted copy stays a plain copy; new invites use `shared_event`).
- Propagation: an organizer edit bumps `version` and a gateway function fans out `upsertCalendarEntryFromSource` to all accepted/maybe members (small N, cap in section 5). Cancel sets copies to `status='cancelled'` (the producers already support `cancelCalendarEntriesForSource`, `calendar-invite.ts:41`). Members' own fields (reminder offsets, emoji, completed) are not overwritten.
- Privacy: every existing read path keeps working unchanged because the copy is a normal row owned by the member. Attendee list lives only in the new table, read only through one gateway function.
- Cost: fan-out on edit (bounded), small drift risk if a fan-out fails; mitigated by `version` and a reconcile on window read (compare copy `metadata.shared_version`, repair lazily) plus a nightly sweep.

Recommendation: **B.** It reuses everything built in VTID-04331/04356/04917/04995 and keeps the privacy boundary where it already is (one member, one row). A is cleaner in theory and costs rewriting all read paths with leak risk.

## 4. Lifecycle

1. **Create.** Organizer creates a normal one-off `manual` entry (or an existing one) and taps Invite, picking members. First invite promotes it to a shared event: create `calendar_shared_events` + organizer member row, stamp the organizer's row `source_ref_type='shared_event'`... only if it has no source_ref yet (manual entries have none, so the unique index is satisfied; entries owned by another source stay uninvitable).
2. **Invite.** Gateway validates each invitee (section 5), inserts a member row `invited`, sends the invite card into the existing DM thread (reuses the 04917 card, now carrying `shared_event_id`) and a notification. Invitee gets no calendar row until they answer (pending invites live in an "Invitations" list, not on the grid; optional tentative display is open question 7).
3. **Answer.** Accept: upsert copy, return an overlap warning. Maybe: upsert copy flagged `metadata.rsvp='maybe'`, shown dashed and still counts as busy for them. Decline: cancel/delete copy, organizer sees a decline. Changing the answer later is allowed until the event ends.
4. **Edit (organizer only).** Allowed fields: title, description, time, location. Gateway bumps `version`, fans out, notifies accepted/maybe members; a time change resets "accepted" to "needs re-confirm" only if the open question 4 answer says so. Invitee copies of a shared event become **read-only for these fields** (frontend `entry-actions.ts` change plus a gateway check in `PATCH /events/:id` and `/move`); invitees may still set their own reminder, emoji, colour, done flag.
5. **Cancel (organizer only).** Marks shared event `cancelled`, cancels all copies, posts a "cancelled" system message in the thread, notifies. Deleting the organizer entry (`DELETE /events/:id`) on a shared event is turned into cancel with a confirm.
6. **Invitee leaves.** Invitee removes the copy: gateway marks member `left` (not just a local delete; today a local remove leaves a stale "accepted"). The organizer is told once. The invitee cannot be re-invited by the organizer for 30 days unless they ask (anti-nag).
7. **Organizer deletes the account.** Shared event is cancelled with reason "organizer left" and copies are kept as plain `manual` entries for members who accepted (their own data), with the organizer shown as "former member" (open question 8). Invitee deleting an account removes only their member row (extend `request-account-deletion/index.ts:38` list; that function already covers `calendar_invite_responses`).
8. **Past events.** No edits, no new invites after the end time (same rule as `calendar-invite.ts:96`).

## 5. Privacy and abuse

**Who may invite whom.** There is no block table and no connection model for DMs today, and `/chat/send` has none of these checks (`GW/routes/chat.ts:55`). Invites are a harassment vector (unsolicited event cards with arbitrary titles, plus a push). Recommended: invite only (a) members the organizer follows/is followed by mutually, or (b) members who already share a conversation thread with them, or (c) co-members of a group the organizer is in, never arbitrary tenant members; tenant must match; unknown ids give the same answer as "not allowed" (no member enumeration). See decision 1.

**Blocks and mutes.** Needs a `member_blocks (blocker_id, blocked_id)` table (does not exist; no block UI found in v1). The invite path must refuse an invitee who blocked the organizer and also reject silently (organizer sees "sent", no push). If the owner prefers to defer blocks, "decline and mute inviter" (invitee-side `invite_mutes (user_id, inviter_id)`) is the smaller minimum. See decision 2.

**What an invitee sees about other attendees.** Default: counts plus names of accepted members who opted to be visible; "maybe/declined" names visible only to the organizer. Invitees never see who else was invited and declined. Alternative: invitees see only counts. See decision 3.

**What the organizer sees about an invitee.** Only that member's answer. At invite time and only to the invitee, the accept dialog says "overlaps with your entry X" (this member's own titles, from their own `findConflicts`). Titles of other entries are never returned to the organizer; the organizer never gets free/busy of the invitee. Any later "find a time for all" feature must return only a merged yes/no per slot, never per-person busy (section 8).

**Test and service accounts (CLAUDE.md Part 1 rules 43-45).** Both directions: a sender or invitee whose id is in `service_bot_accounts` or `notification_test_actors` is refused in code (not only by the notification sink guard, which only drops notifications). The invitee picker excludes them. A staging/real-user test must never create a shared event with the test user: invite writes are covered by Vitest and SQL tests only.

**Rate limits and spam.** App path today has no limit. Proposal: max 20 invitees per event, 30 invites per sender per day, max 5 new invitees per sender per recipient per week, max 10 open (pending) invites per recipient from non-mutual senders; reuse the quota shape of `checkVoiceSendQuota` (`voice-message-guard.ts`) for both app and voice paths. The voice tool must go through the same builder (it currently inserts its own metadata, see section 10).

**Validation.** Title/description length caps, no links in title for non-mutual inviters (open), strip control characters, all text rendered as text (never HTML).

**Notifications and quiet hours.** Reuse the `new_chat_message` push the voice tool already sends (`messaging-depth-tools.ts:830-850`) with a dedicated category `calendar_invite` so members can turn it off. Invite pushes respect the recipient's DND window (queue to window end rather than drop). The 04373 reminder pipeline already shifts default reminders out of quiet hours; an invitee's reminders for accepted shared events use their own prefs (their copy has its own `reminder_offsets`).

**Lock-screen leak.** Push body is "{Name} invited you to an event" with no title/place/time by default; details appear in the app. The owner may opt for full detail (decision 5). Edits and cancels use the same minimal wording.

**RLS.** The service role bypasses RLS, so every check lives in gateway code: caller is organizer for edit/cancel/invite/remove; caller is the invited member for respond; caller is organizer or accepted member for the attendee list; tenant equality; allowlist exclusion; block/mute lookup. New tables still ship RLS deny-by-default plus select policies for `auth.uid()` for defense in depth, and the existing weak policy on `calendar_invite_responses` (sender-only, legacy tables) is replaced in the same migration.

## 6. Gateway API surface (all under `/api/v1/calendar`, `requireAuth` + `requireTenant`, zod `.strict()` bodies)

| Route | Who | Notes |
|---|---|---|
| `POST /events/:id/share` `{ invitees: uuid[] (1..20), message?: string(<=200) }` | organizer of own entry | promotes to shared event, validates every invitee (tenant, allowlists, blocks, relationship, rate), sends cards + notifications; returns per-invitee result |
| `GET /shared/:sharedId` | organizer, accepted member | event + attendee view filtered by visibility rules |
| `POST /shared/:sharedId/respond` `{ response }` | invited member | idempotent; returns `overlaps` (own conflicts) and `action`; replaces `/invites/:messageId/respond` for new invites (old route stays) |
| `PATCH /shared/:sharedId` | organizer | field whitelist, bumps version, fan-out |
| `POST /shared/:sharedId/cancel` | organizer | cancel + fan-out |
| `POST /shared/:sharedId/leave` | member | |
| `DELETE /shared/:sharedId/members/:userId` | organizer | removes an invitee; no notification to others |
| `GET /invitations` | member | pending invites, paginated |
| `PATCH /events/:id`, `/move`, `DELETE /events/:id` | existing | add: if row is a shared copy and caller is not organizer, only member-owned fields allowed; organizer delete becomes cancel |

Every handler gets the user id from the verified JWT (`getUserId`), never from the body. OASIS events: `calendar.shared.created|responded|updated|cancelled` (state transitions only). Add to `docs/validation` goldens and the screen registry only if a new frontend page is added (decision for section 7).

## 7. Frontend surfaces (vitana-v1, for a later VTID)

- Add/edit form: "Invite people" with a member picker restricted to allowed invitees (search through a new gateway endpoint that already applies exclusions; never a raw `profiles` query, rule 45).
- Entry detail: attendee row (avatars, counts, own answer), organizer actions (edit, cancel, remove), invitee actions (accept/maybe/decline, leave); copies of shared events show a lock hint on non-editable fields. `entry-actions.ts` must stop treating shared copies as freely editable.
- Calendar grid: pending invitations as an "Invitations" badge and sheet; maybe shown dashed; cancelled shown struck through for one day.
- Messenger: the existing `CalendarInviteStatus.tsx` card gains live status (updated/cancelled) and the organizer's attendee summary.
- Overlap hint on the accept dialog using the existing conflicts client (VTID-04995).
- i18n: all strings German first, then 10 locales, du-form, via `t()`/`notify()`; invitee names and titles come from data and are bidi-isolated (`dir="auto"`/`<bdi>`). RTL (Arabic): logical properties only, avatar stack and chips mirrored, time ranges isolated. Push copy goes through the server-side catalog `tt()` per recipient locale.
- New screens, if any, need `screens.json` entries in the navigation registry (`npm test` fails otherwise); the invitations list is a sheet in the calendar, so no new route is needed.

## 8. Integration with existing pieces

- **Reminders:** each accepted copy is a normal entry, so `calendar-reminders.ts` fires per member with their own offsets and quiet hours; cancelled copies stop reminding. No change besides making sure shared copies are not "recurring".
- **Conflict warning:** `findConflicts(userId, role, start, end, { excludeEventId })` runs on the invitee's own data at invite-view and accept time and again after a time edit; the result goes only to the invitee. The organizer gets a conflict check of their own entry as today.
- **Find-a-time:** later phase only. Would run `findFreeSlots` per attendee server-side and return merged slots with no per-person detail; requires explicit per-event consent from attendees. Not in VTID-04998.
- **Google/Outlook push:** `calendar-google-sync.ts` pushes a member's own rows, so accepted copies go out as the member's event with no attendee list and no organizer email in the external copy. Real two-way invite (ICS METHOD:REQUEST, external attendees) is out of scope.
- **ICS feed:** `calendar-ics-feed.ts` exports each member's own rows, so shared copies appear without attendees; cancelled copies export as cancelled.
- **Community events:** remain the public mechanism. A shared event can never be created from a `community_event`/`live_room_session` entry (those keep the 04917 "invite to join" card pointing at the real event). No change to the RSVP triggers.
- **What's New:** this is a brand-new finished feature once the whole flow (invite, answer, edit/cancel propagation, privacy) is live: one entry in `vitana-v1/src/whats-new/entries/` in the final frontend PR only, not for partial steps.

## 9. Test and rollout plan

- **Flag:** `CALENDAR_SHARED_EVENTS_ENABLED` (gateway env, default off) plus a per-tenant allow list for the first rollout; frontend hides the picker when the gateway reports the capability off.
- **Phases:** (1) bug fixes + invite-path guards (allowlists, rate limits, voice path through the shared builder) on the existing messenger flow; (2) tables + shared event model + respond/edit/cancel/leave; (3) frontend picker, attendee row, invitations sheet; (4) notifications categories, What's New, enable per tenant.
- **Tests (Vitest/Jest, in-memory DB, no network):** pure functions for invitee validation, visibility filtering, version/fan-out planning, field whitelist; route contract tests for every route (401, 403 non-organizer, 404 unknown/blocked invitee looks identical, 409 past/cancelled); regression that service/test accounts cannot invite or be invited (rules 43-45); idempotency of repeated respond/fan-out against the unique index; `npm run test:operator` and the calendar suites stay green. Add a scenario file `vtid-04998-shared-events.test.ts`. SQL tests (pgTAP-style, run against a local/branch database, never production): unique index behavior for `(user_id, shared_event_id, 'shared_event')`, RLS deny-by-default on both new tables, cascade on organizer account deletion.
- **Staging:** staging shares the production Supabase project and STAGING-VERIFY is read-only (CLAUDE.md "Why no host is exempt"), so no staging test may create invites. Staging proof is read-only: the new routes return 401/200-empty for the test user, the picker endpoint excludes allowlisted accounts, the flag-off response. Anything that writes is proven in CI only. A real end-to-end check needs an isolated Supabase project, which does not exist; this is a blocker to state in the Gate 2 message, not something to route around.
- **Migrations:** additive only (two tables, one CHECK-free column use of existing `source_ref_type`, `source_type` unchanged); no change to `valid_source_type`. Register in `DATABASE_SCHEMA.md`.
- **Rollback:** flag off hides everything; copies are normal entries and remain valid.

## 10. Risks and open questions

Defects found in the current flow (verified by reading, not by running):
1. **Voice invites cannot be answered.** `tool_send_calendar_invite_in_chat` stores metadata `{source:'voice', kind, event_id, title, ...}` with no `v: 2` and no `ref_type`/`ref_id` (`messaging-depth-tools.ts:812-826`), and `inviteMetadataOf` rejects anything but `v===2` with `ref_type` (`calendar-invite.ts:176-186`), so `respond`/`GET /invites` return 404 for them. It also skips `buildInviteFromEntry`, so a voice invite can name a private or past entry. Fix: route it through `buildInviteFromEntry`.
2. **Stale cards and copies.** Organizer edit/cancel never reaches the card or the recipient's copy (section 2); a cancelled event keeps showing as accepted.
3. **Recipient can rewrite the organizer's event** locally (`entry-actions.ts:36`), so copies drift silently.
4. **App chat path has no relationship, block, allowlist or rate check**, so any tenant member can send a calendar-invite card (and with it a push) to any other member.
5. **Group invite** to a large group is a single message with no cap on recipients.

Risks of the design: fan-out failures leave drift (mitigated by `version` + reconcile); privacy regressions if a new read path leaks the attendee table (only one gateway function reads it); notification fatigue; a harassing organizer using titles (reports use the existing message-report path; open: add a "report invite" action); time-zone display for invitees in another zone (store UTC + organizer timezone, display in the invitee's zone, as existing entries do).

Open question for engineering, not the owner: whether a group invite should create per-member invited rows at send time (needs group member listing, capped) or stay an open card anyone in the group can answer (today's behavior, simpler, but no organizer control). Recommended: keep the open card for groups, per-member rows for DMs and picker invites.

## 11. Decisions for the owner

1. **Who may invite whom?** Options: (a) anyone in the tenant; (b) only people with an existing relationship (mutual follow, shared conversation, or shared group); (c) only mutual connections. Recommendation: **(b)**. It stops cold-invite spam and harassment, which the app has no tools for today (no blocks, no limits), yet does not force a new connection model.
2. **Blocks and mutes: build now or defer?** Options: (a) full `member_blocks` table and a Block action in profile and chat; (b) only "decline and mute this inviter" on the invitation; (c) none. Recommendation: **(b) in this VTID, (a) as its own VTID.** Smallest thing that gives an invitee a way out, without opening a broader moderation feature.
3. **What do invitees see about other attendees?** Options: (a) only counts; (b) counts plus names of members who accepted; (c) full list including maybe/declined. Recommendation: **(b)**, organizer alone sees maybe/declined names. People expect to know who is coming, but nobody should see who turned someone down.
4. **When the organizer changes time or place, do accepted members have to re-confirm?** Options: (a) never, they are notified; (b) only if the start moves by more than 60 minutes or the day changes; (c) always. Recommendation: **(b)**. A small fix should not spam, a real move should not silently hold someone to a time they did not agree to.
5. **Push content on the lock screen.** Options: (a) generic ("{Name} invited you to an event"); (b) title only; (c) title, time and place. Recommendation: **(a)**, with the details one tap away in the app. Event titles are sender-controlled text and can be private or abusive, and push cannot be recalled.
6. **Limits.** Options: (a) as proposed (20 invitees per event, 30 invites per sender per day, 5 per sender-recipient pair per week); (b) stricter (10 / 10 / 2); (c) no limits at first. Recommendation: **(a)**, adjustable by env var, so legitimate use (a run club of 15) works and bulk spam does not.
7. **Do pending invitations appear on the calendar before the member answers?** Options: (a) no, only in the Invitations sheet; (b) as a faint tentative block; (c) as a normal entry. Recommendation: **(a)**. Unanswered invites should not change the member's busy picture or reminders, and (b) leaks an unaccepted claim on their time.
8. **If the organizer deletes their account.** Options: (a) cancel the event for everyone; (b) keep it for members who accepted, as a plain entry without an organizer; (c) transfer to the first accepted member. Recommendation: **(b)**. Members keep their own plans, and no one silently inherits control.
9. **Can an invitee change their own copy?** Options: (a) fully (today's behavior); (b) only personal fields (reminder, colour, done); (c) nothing. Recommendation: **(b)**. Title, time and place belong to the organizer so the copies cannot drift, while the member still controls how their own day looks.
10. **Rollout order and scope for the first release.** Options: (a) invite-flow fixes and guards only (defects 1, 4, 5 above); (b) full shared events behind a per-tenant flag in four phases; (c) full release at once. Recommendation: **(b)**, starting with phase 1 as its own quick VTID since it closes live privacy gaps independent of the new model.
