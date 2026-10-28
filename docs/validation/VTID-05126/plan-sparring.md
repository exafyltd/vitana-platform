# Plan Sparring record — Share any of my upcoming calendar entries (feed + chat)

- **VTID:** VTID-05126
- **Change class:** standard
- **Plan hash** (sha256 of the text between the plan markers): `49a0a63f9193c4d8173e7a324fd1af5d6fa9ec1ba71340d46704146876853c8a`
- **Sparring session** (`plan_sparring_sessions`, trust tier `attested`, verdict `converged`): `8da0ef26-fd23-4a9e-b329-83e3f5a3b1f1`
- **Partner:** independent `plan-sparring-partner` agent (read-only), 2 rounds
- **Verdict:** CONVERGED after 2 rounds; nothing disputed
- **Owner approval:** 2026-10-12 in the Claude Code session ("Approved", after reviewing the mobile mockups). The binding exafy_admin approval click (`POST /api/v1/plans/spar/:id/approve`) is pending.

---

# Plan — Share any of my upcoming calendar entries (feed + chat)

Owner request 2026-10-12: "User should be able to share their upcoming event, no matter if business or private or medical or whatever else." Today (VTID-04916/04917) Share to feed exists only for community events and live rooms, and Invite only for the member's own manual/invite entries; a reminder (e.g. "Erinnerung: Geburtstag von Maria Maksina", source_type `reminder`) shows neither button.

Repos: exafyltd/vitana-v1 (FE + `supabase/migrations` owning `profile_posts`), exafyltd/vitana-platform (GW = `services/gateway/src`).
Research base: v1 @ bcae4d0, platform @ origin/main 2026-10-12.

<!-- plan:begin -->

## Change class
**standard** (migration, gateway route/service change, ORB tools, FE). One VTID, two PRs (v1 migration + FE; platform gateway), v1 migration applied before the gateway PR merges.

## Scope
- v1 `supabase/migrations/<new>_profile_posts_calendar_entry_share.sql`
- v1 FE: `src/lib/post-attachment.ts`, `src/components/feed/EventAttachmentCard.tsx`, `src/components/calendar/vcal/ShareToFeedPanel.tsx`, `src/components/calendar/vcal/entry-actions.ts`, `src/components/calendar/vcal/EntryScreen.tsx` (labels only), `src/lib/calendar-window-client.ts` (adds `calendar_entry` to the attachment/ref types and the share body fields `card_title`/`include_location`; window items gain `invitable`), i18n `vcal.share.*` / `feed.attachment.*` in all 11 locales, tests, staging spec.
- GW: `services/calendar-share.ts`, `services/calendar-invite.ts`, `routes/calendar.ts` (share body schema + window `shareable`), `services/orb-tools/calendar-social-tools.ts` (descriptions), tests, `DATABASE_SCHEMA.md`, `kb/instruction-manual/maxina/12-utility/calendar.md`.

## Rule after this change
**Every one of the member's own calendar entries can be shared while it is upcoming** — business, private, medical, reminder, imported (Google), Autopilot, assistant-made, whatever its source. Never: another person's entry, a busy block (someone else's availability), a cancelled, completed or ended entry. Sharing always needs the member's explicit tap/confirmation; nothing is ever shared automatically.

Recurring entries (rrule / occurrence_index ≠ null): **not in this change** (Share and Invite stay hidden for series), because a share and an invite point at one concrete date and the server cannot yet validate an occurrence time. Tracked as a follow-up.

## 1. Data (v1 migration)
1. `profile_posts_attached_ref_type_check` gains `'calendar_entry'` (`attached_ref_id` = the member's `calendar_events.id`).
2. New column `profile_posts.attached_snapshot jsonb` (nullable): `{ title, start_time, end_time, location, emoji, status }`. Required (CHECK) when `attached_ref_type = 'calendar_entry'`, null otherwise. Reason: other members cannot read the author's `calendar_events` (owner-only RLS), so the card renders from the snapshot the gateway writes; nothing else from the entry (description, notes, source, health tags, attendees, metadata) is ever copied.
3. `profile_posts_guard_attached_ref`: also blocks `anon/authenticated` from setting or changing `attached_snapshot` (same pattern as the reference).
4. Snapshot stays current: `AFTER UPDATE OF title,start_time,end_time,location,status ON calendar_events` trigger (`SECURITY DEFINER`, v1 migration next to the profile_posts guard because it writes profile_posts) updates the snapshot of posts with `attached_ref_type='calendar_entry' AND attached_ref_id = NEW.id`, keeping the member's own edited card title (see 3b) and location choice (location only updated if the snapshot already has one). Delete of the entry → snapshot.status = 'cancelled' (AFTER DELETE). The card then shows "Abgesagt" / moved time like event cards do.
5. `notify_community_on_public_post`: a new explicit branch `ELSIF NEW.attached_ref_type = 'calendar_entry' THEN v_event := NULLIF(TRIM(NEW.attached_snapshot->>'title'), '')` next to the two existing lookups (today an unknown type would leave `v_event` NULL); same `community_event_shared` type, same 24 h per-recipient dedup on `ref_id`, same admin switch (VTID-04674), same test-actor skip. Private posts (`is_public=false`) notify nobody, as today (trigger `WHEN NEW.is_public`).
6. Unique index unchanged: one share per member per entry.

## 2. Gateway
1. `calendar-share.ts`:
   - `shareRefOf(entry)` returns the community event / live room ref as today; otherwise, for the member's own non-busy entry, `{ ref_type: 'calendar_entry', ref_id: entry.id }`.
   - `isShareableEntry` is **rewritten** (today, `calendar-share.ts:72-77`, it only checks cancelled + a community/live-room ref + not ended). New checks, each new code: own entry (`user_id`), not busy, `status !== 'cancelled'`, not completed (`completed_at`/`completion_status`), not ended, `rrule` null and not an occurrence (`occurrence_index` null). The gateway is the single authority: the window item's `shareable` flag and a new `invitable` flag come from it; the FE only reads the flags.
   - Ordering is fixed: `shareRefOf` tries the community-event / live-room ref first (unchanged code path), and only an entry without one becomes `calendar_entry`. So an RSVP entry of a community event is always shared as `community_event` and the one-share-per-event index keeps working; a test pins that no community/live-room entry ever yields `calendar_entry`.
   - `checkShareTarget` for `calendar_entry`: re-reads the entry as the owner (exists, not cancelled/completed/ended).
   - `shareCalendarEntryToFeed` writes `attached_snapshot` for `calendar_entry` from the entry: title = `input.card_title` (trimmed, ≤ 120) or the entry's display title; `location` only when `input.include_location === true`; never description or any other field.
   - Rate limits unchanged (5 shares/member/24 h, duplicate-post guard).
2. `routes/calendar.ts` share body (zod strict) gains `card_title?: string(≤120)`, `include_location?: boolean`; window items' `shareable` follows the new `isShareableEntry`.
3. `calendar-invite.ts`: `buildInviteFromEntry` accepts every own upcoming non-recurring, non-busy entry (drops the manual/invite-only allow-list); the card's `title`/`location` follow the same `card_title` / `include_location` choice (chat send routes accept them in `content_data`, validated server-side), everything else stays server-built. Accepting a `calendar_entry` invite still copies only title/time/location into the recipient's calendar.
4. ORB tools (`share_calendar_entry_to_feed`, `invite_to_calendar_entry`): descriptions widened to any own upcoming entry; new optional args `card_title`, `include_location`; the confirmed-call rules stay (confirmed + is_public required, not over, memberHasSpoken in live). Health/medical sources (`health_plan`, `lab_order`, `appointment`, `test_result`): enforced in code, not left to the prompt — the preview returns `sensitive: true` and a STATUS line telling the model to name it as a health appointment and to read back the exact card title and whether the location is shown; a confirmed call for a sensitive entry must also carry `sensitive_ack: true` (else `STATUS: needs_sensitive_ack`, nothing posted/sent), so the model cannot post it on a bare yes without having surfaced it.
5. The refusal texts `SHARE_REFUSAL.NOT_SHAREABLE` / `INVITE_REFUSAL.NOT_INVITABLE` (`calendar-social-tools.ts`) and the tool descriptions drop "only events and live rooms" and name the new rule (own, upcoming, not a series, not cancelled/finished).
6. `DATABASE_SCHEMA.md`, KB calendar page.

## 3. App (v1)
1. EntryScreen: Share appears when the window item's `shareable` is true, Invite when its new `invitable` is true — both computed by the gateway. `entry-actions.ts` `canInviteEntry` drops the `EDITABLE_SOURCES` (manual/invite) gate and reads `item.invitable` (keeps the not-ended / not-done checks as a defensive second look). Reminder, Autopilot, health, imported entries now get both buttons.
2. ShareToFeedPanel:
   a. Preview of exactly what others will see (the card).
   b. Editable **card title** (prefilled with the entry title) — so "Erinnerung: Geburtstag von Maria Maksina" can become "Marias Geburtstag" or anything else.
   c. **Ort zeigen** toggle (default off for own entries; on for community events/live rooms whose location is already public).
   d. Audience: Community / Nur ich (as today).
   e. For health/medical sources a one-line hint ("Du teilst einen Gesundheitstermin — prüfe, was andere sehen.") above the Post button; no block.
3. Invite sheet: same title/location controls in a compact form.
4. Feed card — two rendering paths, chosen in `post-attachment.ts`:
   - `community_event` / `live_room_session`: unchanged (`fetchAttachedEvent` live query).
   - `calendar_entry`: `attachedRefOf` accepts the new type and reads `attached_snapshot` straight off the post row (the feed loads `profile_posts` with `select("*")`, `useAllNewsFeed.ts:171`, so the column arrives with no query change; PostDetail likewise); a new pure `snapshotAttachedEvent(row, now)` builds the same `AttachedEvent` shape (state from snapshot times + `status`), no remote fetch. `EventAttachmentCard` takes the already-built event for this type and only queries for the two live types.
   - Card: title, date/time, location if shared, emoji, state (bevorstehend / läuft / vorbei / abgesagt); no RSVP; CTA **"In meinen Kalender"** → `POST /api/v1/calendar/feed-posts/:postId/add` (new gateway route): auth; the post must be public, not the caller's own, `attached_ref_type='calendar_entry'`; the server re-reads the **post row's current snapshot** and refuses when `status='cancelled'` or the end time is past (409 `NOT_OPEN`); copies only title/times/location via `upsertCalendarEntryFromSource` (`source_type 'invite'` — already in `CALENDAR_SOURCE_TYPES` — `source_ref_type 'feed_post'`, `source_ref_id = post id`; `source_ref_type` is free text, no enum or DB check: `calendar-producers.ts:48,160` only require it non-empty) — idempotent by that key. Accepted race: if the author cancels in the instant between the snapshot read and the copy, the viewer keeps a copy of a just-cancelled plan; the existing invite path has the same property and the copy is the viewer's own entry, which they can remove.
5. i18n DE first (du-form), then EN, then the 9 other locales (`_pending_review`). Logical properties for RTL.
6. No What's New entry (improvement of an existing feature).

## Out of scope
- Recurring series / single occurrences (follow-up).
- Sharing someone else's entry or a busy block.
- Changing the notification switch default (stays per-tenant admin decision).

## Test plan
- **No production writes, no test posts anywhere** (posts fan out to the tenant). Writes proven by Vitest/Jest only.
- Gateway Jest: shareable rule matrix over every `CALENDAR_SOURCE_TYPES` value (own+upcoming → yes; busy/cancelled/completed/ended/series/foreign → no); snapshot contains only title/times/location(if chosen)/emoji/status — never description/metadata (assert key set); card_title/include_location validation; invite widened + same field rules; feed-post add route (public only, not own, idempotent, over/cancelled refused); ORB tools sensitive flag + unchanged guards; calendar suite + manifest + goldens.
- Migration test (platform/v1 pattern): constraint values, snapshot CHECK, guard blocks client snapshot writes, sync trigger updates title/time/status and respects edited title / hidden location, notify branch uses snapshot title and dedup.
- Vitest: ShareToFeedPanel (title edit, location toggle default, health hint, payload shape), EventAttachmentCard calendar_entry states + "In meinen Kalender", entry-actions matrix, RTL render.
- `npm test`, `npm run lint`, `npm run build`, `npm run i18n:inventory`.
- Staging (read-only Playwright): open a reminder entry on `/calendar/entry/:id`, see Share and Invite, open both sheets, edit title, toggle location — **never submit**; gateway http probes for the new route (401 unauthenticated). Read-only GET of an existing feed post if one with a calendar_entry exists naturally, else Vitest only.

<!-- plan:end -->


---
## Planner responses — round 1
- **F1 [minor] file name** — ACCEPTED. `ShareToFeedPanel.tsx` everywhere.
- **F2 [major] isShareableEntry rewrite understated** — ACCEPTED. §2.1 now lists every check as new code and makes the gateway the single authority (`shareable` + new `invitable` flags).
- **F3 [major] two rendering paths unspecified** — ACCEPTED. §3.4 specifies `attachedRefOf` + new `snapshotAttachedEvent` for `calendar_entry` (no remote fetch), live query unchanged for the two event types; verified the feed selects `*` (`useAllNewsFeed.ts:171`) so `attached_snapshot` arrives without a query change.
- **F4 [major] notify trigger branch** — ACCEPTED. §1.5 names the explicit `ELSIF … 'calendar_entry'` branch.
- **F5 [major] add-to-calendar freshness** — ACCEPTED. §3.4: the route re-reads the post's current snapshot server-side and refuses `cancelled`/ended (409); delete → snapshot cancelled via the AFTER DELETE trigger; the residual race is documented and accepted (same as the invite path; the copy is the viewer's own removable entry).
- **F6 [minor] entry-actions.ts scope** — ACCEPTED. It was already in scope; §3.1 now says exactly what changes (drop `EDITABLE_SOURCES` gate, read `item.invitable`).
- **F7 [minor] calendar-window-client.ts unspecified** — ACCEPTED. Scope line now lists the type/field changes.
- **F8 [minor] sensitive flag only in the prompt** — ACCEPTED, hardened: `sensitive_ack: true` required on the confirmed call for health sources, enforced in the handler.
- **F9 [minor] community event shared twice via two ref types** — ACCEPTED as a confirmation: §2.1 fixes the ordering (community/live-room ref first) and adds a test that such entries never yield `calendar_entry`.
- **Q1/Q3 `feed_post`** — Verified: `feed_post` is a `source_ref_type`, which is free text (`calendar-producers.ts:48,160` require only non-empty; no DB CHECK on `source_ref_type`); the `source_type` used is `invite`, already in `CALENDAR_SOURCE_TYPES` and the DB constraint. No enum/constraint change needed.
- **Q2 rrule enforcement** — Gateway enforces (`rrule` null, `occurrence_index` null) for both flags; the FE reads the flags.

## Planner responses — round 2
- **F10 [minor] test plan names ShareToFeedSheet** — ACCEPTED, fixed.
- **F11 [minor] refusal texts still say events/live rooms only** — ACCEPTED, added as §2.5.

**Verdict: CONVERGED** after 2 rounds (round 2: every round-1 finding closed, no new blocker or major).
