# B5 — Realtime Subscription Inventory (VTID-03736)

Part of `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s B5 workstream. The
plan's own summary table (line 24) states: *"60 `.channel()` in frontend,
19 in gateway."* This pass live-verifies both halves of that claim against
the current `main` of each repo and produces the actual per-table breakdown
needed to plan the replacement mechanism — the plan itself flags B5 as one
of the three workstreams (with B3/B7) where "getting this wrong locks out
every user or, worse, silently breaks tenant isolation," so precision here
matters more than for a typical inventory pass.

## Gateway count: plan says 19, live `main` has 0

`grep -rn "\.channel(" services/ scripts/` (excluding tests) returns **zero**
matches anywhere in this repo, and a broader sweep for `postgres_changes`
also returns zero. Every remaining `realtime`-flavored hit in
`services/gateway/src` is ORB's own "live voice" naming (`orb/live/...`,
`nova-ws-facade.ts`, `vertex-live-client.ts`) — a different meaning of
"live/realtime" entirely, not Supabase Realtime.

**Conclusion: the gateway has no Supabase Realtime subscriptions today.**
The plan's "19 in gateway" figure is stale relative to current `main` — most
likely those call sites were already removed in an earlier, undocumented
refactor (the gateway is a server process; a backend subscribing to its own
database's change stream via the client-side Realtime API is an unusual
pattern to begin with, and is not present now regardless of how it got
there). This is a correction to the plan's headline numbers, in the same
spirit as this session's Phase 0 correction of the "154k dropped rows"
finding: verify the live/current state before scoping the remaining work.

## Frontend count: confirmed accurate — 60 calls, 39 files

`exafyltd/vitana-v1`, `src/`, current `main` (`8689211`), excluding tests:
**60** `.channel(` call sites across **39** files — matches the plan
exactly. Full breakdown:

| File | `.channel()` calls | Kind(s) | Table(s) watched |
|---|---|---|---|
| `hooks/useTenantMessages.ts` | 6 | pg_changes, broadcast | `message_threads`, `messages` |
| `hooks/useCallState.ts` | 6 | broadcast, presence | — |
| `hooks/useUnreadSync.ts` | 3 | pg_changes, broadcast | `global_thread_participants`, `thread_participants` |
| `hooks/useTypingIndicators.ts` | 3 | broadcast | — |
| `components/notifications/CrossSystemNotifier.tsx` | 3 | broadcast | — |
| `hooks/useChatUnreadCount.ts` | 2 | pg_changes | `chat_messages` |
| `hooks/useActivityHistory.ts` | 2 | pg_changes | `ai_messages`, `user_activity_log` |
| `hooks/useCalendarEvents.ts` | 2 | pg_changes | `calendar_events`, `calendar_invite_responses` |
| `hooks/useWalletRealtime.ts` | 2 | pg_changes | `user_wallets`, `wallet_transactions` |
| `hooks/useMessages.ts` | 2 | pg_changes | `message_threads`, `messages` |
| `hooks/useGroupPosts.ts` | 1 | pg_changes | `global_messages` |
| `hooks/useGlobalMessages.ts` | 1 | pg_changes | `chat_messages` |
| `hooks/useContacts.ts` | 1 | pg_changes | `contacts` |
| `hooks/useCampaignAnalytics.ts` | 1 | pg_changes | `campaign_recipients` |
| `hooks/useBookmarks.ts` | 1 | pg_changes | `bookmarked_items` |
| `hooks/useMessageReactions.ts` | 1 | pg_changes | `message_reactions` |
| `hooks/useChatGroupsAsThreads.ts` | 1 | pg_changes | `chat_messages` |
| `hooks/useFollow.ts` | 1 | pg_changes | `user_follows` |
| `hooks/useNotifications.ts` | 1 | pg_changes | `user_notifications` |
| `hooks/useRealtimeConnection.ts` | 1 | (generic reconnect helper, no table) | — |
| `hooks/useEventParticipation.ts` | 1 | pg_changes | `global_event_participants` |
| `hooks/useCart.ts` | 1 | pg_changes | `cart_items` |
| `hooks/useProfileTheme.ts` | 1 | pg_changes | `profiles` |
| `hooks/useUserSupplements.ts` | 1 | pg_changes | `user_supplements` |
| `hooks/useCommunityEvents.ts` | 1 | pg_changes | `global_community_events` |
| `hooks/useUserPresence.ts` | 1 | presence | — |
| `hooks/useAppointmentNotifications.ts` | 1 | pg_changes | `provider_appointments` |
| `hooks/useWebRTC.ts` | 1 | broadcast, presence | — |
| `hooks/useAllNewsFeed.ts` | 1 | pg_changes | `media_uploads`, `profile_posts` |
| `components/MessengerCall.tsx` | 1 | broadcast | — |
| `components/meetups/MeetupDetailsDrawer.tsx` | 1 | pg_changes | `global_event_participants` |
| `components/messages/CalendarInviteStatus.tsx` | 1 | pg_changes | `calendar_invite_responses` |
| `components/diary/DiaryEntryList.tsx` | 1 | pg_changes | `diary_entries` |
| `pages/admin/community/Events.tsx` | 1 | pg_changes | `global_community_events` |
| `pages/admin/community/ReportedContentNew.tsx` | 1 | pg_changes | `content_reports`, `user_suspensions` |
| `pages/admin/community/Groups.tsx` | 1 | pg_changes | `global_community_groups` |
| `pages/admin/community/ReportedContent.tsx` | 1 | pg_changes | `content_reports` |
| `pages/messages/GroupChat.tsx` | 1 | pg_changes | `chat_messages` |
| `context/ProfileProvider.tsx` | 1 | pg_changes | `profiles` |

## The two categories, and why they need different migration plans

**`postgres_changes` (32 of 39 files, ~50 of 60 calls) — genuinely tied to
Postgres's WAL/logical replication.** Supabase Realtime's `postgres_changes`
feature works by having its Elixir service subscribe to the source
database's write-ahead log via a replication slot and fan out row-level
change events to subscribed clients. **This is the part that cannot simply
"point at Aurora"** — it requires either (a) running a Realtime-compatible
service (Supabase's own `realtime` is open-source and can in principle run
against any Postgres, including Aurora, with its own replication slot) or
(b) replacing each of these 30 distinct table subscriptions with a
different push mechanism (a gateway-owned WebSocket/SSE layer fed by
Aurora's own logical replication, or, for lower-frequency tables, polling).

Distinct tables under `postgres_changes` (30): `message_threads`,
`messages`, `global_thread_participants`, `thread_participants`,
`chat_messages`, `ai_messages`, `user_activity_log`, `calendar_events`,
`calendar_invite_responses`, `user_wallets`, `wallet_transactions`,
`global_messages`, `contacts`, `campaign_recipients`, `bookmarked_items`,
`message_reactions`, `user_follows`, `user_notifications`,
`global_event_participants`, `cart_items`, `profiles`, `user_supplements`,
`global_community_events`, `provider_appointments`, `media_uploads`,
`profile_posts`, `diary_entries`, `content_reports`, `user_suspensions`,
`global_community_groups`.

**⚠️ Two of these tables were already flagged in B2 as not existing in
`public` under those exact names — worth reconciling, not re-diagnosing
here:** `user_wallets` exists (per B2's wallet-family spot-check) but is
not the `wallet_balances` table `services/gateway` code separately expects
— these may be two different, both-real parts of the wallet system, or one
more sign the wallet schema is in an unsettled state. `wallet_transactions`
was not checked directly in B2 — **checked now, 2026-08-27:
`to_regclass('public.wallet_transactions')` resolves, it exists.** Not a
dead subscription target.

**`broadcast`/`presence` (7 files: `useCallState.ts`, `useTypingIndicators.ts`,
`CrossSystemNotifier.tsx`, `useWebRTC.ts`, `MessengerCall.tsx`,
`useUserPresence.ts`, `useRealtimeConnection.ts`) — ephemeral, DB-independent.**
Broadcast and presence channels are pure pub/sub — no table, no WAL, no
persistence. Typing indicators, call signaling/WebRTC negotiation, and
online-presence tracking never touch Postgres at all. **These do not block
on the Aurora migration in any way** — they could keep running against
Supabase's Realtime service indefinitely as a pure message bus, or move to
any lightweight WS relay, entirely independent of whether the underlying
database is Supabase-hosted Postgres or Aurora. Sizing the B5 problem at
"60 subscriptions" overstates the true Aurora-coupled surface — it's
realistically the ~30-table `postgres_changes` list above, not all 60.

## Not done in this pass

- Did not check `exafyltd/vitana-mobile` for its own Realtime usage — the
  plan's 60/19 split only names frontend + gateway; whether the mobile app
  has independent subscriptions is unverified.
- Did not assess per-table criticality/traffic volume (the plan's own next
  step for B5: "assess how many are genuinely live-critical" vs. tables
  where a client could tolerate polling instead). `chat_messages` (3
  separate subscribing files) and `message_threads`/`messages` (paired,
  6+2 calls) are the obvious high-traffic candidates worth a real-time
  mechanism; single-subscriber tables like `contacts`, `cart_items`,
  `user_supplements` are plausible polling candidates, but this is a
  product call, not inferred here.
- Did not investigate whether Supabase's `realtime` server is deployable
  against Aurora directly (option (a) above) vs. needs to be replaced
  wholesale by a gateway-owned relay (option (b)) — this is a real
  architecture decision for whoever picks up B5 execution, not resolved by
  an inventory pass.

## Addendum (VTID-03764 chain), 2026-08-28 — per-table criticality, live-measured

The prior pass explicitly deferred "assess how many are genuinely
live-critical" as a product call. It doesn't have to be a guess: Aurora
(DMS-replicated from Supabase) already carries real write-activity signal
per table, queryable read-only via the RDS Data API (`aws rds-data
execute-statement`, HTTPS — the same access path B4/Phase 0 established;
no IAM-denied service needed). Queried directly against the `vitana`
database (**not** `postgres` — the default database on this cluster has
zero tables in `public`; the real 586-table schema lives in `vitana`) for
all 30 `postgres_changes` tables named above: `n_live_tup` and
`n_tup_ins+n_tup_upd+n_tup_del` from `pg_stat_user_tables`.

**Caveat before reading the numbers:** CDC has been down since 2026-08-20
(`docs/AURORA-PHASE0-RECONCILIATION-2026-08-27.md`), so these are frozen at
whatever DMS had replicated by then, not live-to-the-minute — but relative
ordering across tables (which is all this triage needs) is unaffected by a
uniform staleness cutoff.

| Table | Live rows | Write activity (ins+upd+del) | Tier |
|---|---:|---:|---|
| `user_activity_log` | 135,960 | 135,960 | **Hot** |
| `user_notifications` | 63,399 | 67,249 | **Hot** |
| `chat_messages` | 41,217 | 41,255 | **Hot** |
| `user_wallets` | 690 | 690 | Warm |
| `ai_messages` | 530 | 530 | Warm |
| `global_messages` | 375 | 375 | Warm |
| `diary_entries` | 252 | 252 | Warm |
| `message_reactions` | 237 | 237 | Warm |
| `profiles` | 205 | 209 | Warm |
| `profile_posts` | 179 | 317 | Warm |
| `user_follows` | 138 | 138 | Cool |
| `global_community_events` | 123 | 123 | Cool |
| `global_thread_participants` | 118 | 125 | Cool |
| `wallet_transactions` | 85 | 85 | Cool |
| `media_uploads` | 44 | 44 | Cool |
| `calendar_invite_responses` | 35 | 35 | Cool |
| `global_event_participants` | 18 | 18 | Cool |
| `cart_items` | 13 | 13 | Cool |
| `messages` | 12 | 12 | Cool |
| `thread_participants` | 10 | 10 | Cool |
| `message_threads` | 5 | 5 | Cool |
| `bookmarked_items` | 5 | 5 | Cool |
| `provider_appointments` | 4 | 4 | Cool |
| `user_supplements` | 2 | 2 | Cool |
| `contacts` | 2 | 2 | Cool |
| `global_community_groups` | 1 | 1 | Cool |
| `calendar_events` | 0 (dead tuples only) | 4,482 | Cool — churny but tiny live set |
| `campaign_recipients` | 0 | 0 | Cool — unused/empty |
| `content_reports` | 0 | 0 | Cool — unused/empty |
| `user_suspensions` | 0 | 0 | Cool — unused/empty |

**This corrects, not just extends, the prior pass's inference.** The prior
pass flagged `message_threads`/`messages` (6+2 subscribing calls across two
files) as an "obvious high-traffic candidate" by subscriber-count — but the
real data shows both tables are nearly empty (12 and 5 rows respectively).
`chat_messages` — 3 subscribing files, the same tier the prior pass put it
in — is genuinely hot, 3-4 orders of magnitude above every table below the
top three. Subscriber/file count and actual write volume are not the same
signal, and this session's access to live Aurora stats settles which one
matters for B5 sequencing: **`user_activity_log`, `user_notifications`, and
`chat_messages` are the three tables where a genuine push mechanism
(Supabase-`realtime`-on-Aurora or a gateway relay) earns its cost first.**
Every other table in this list is a plausible polling-interval candidate
(seconds-to-minutes, not milliseconds) given how rarely rows actually
change, and the four zero/near-zero rows (`campaign_recipients`,
`content_reports`, `user_suspensions`, and effectively `calendar_events`,
which has live writes but zero live rows) may not need a live subscription
at all today.

**Still not decided here, deliberately:** which mechanism — Supabase's own
`realtime` pointed at Aurora, or a gateway-owned relay — serves the three
hot tables. That remains the real architecture call the prior pass named,
now scoped to 3 tables instead of "60 subscriptions" or "30 tables," which
is a materially smaller decision to make and to get wrong.

## Addendum, 2026-08-28 — option (a) feasibility check: NOT viable today, live-verified

The prior addendum narrowed the decision but not, deliberately, which side
of it to take. One half of that decision — "can Supabase's own `realtime`
server even attach to Aurora as-is" — is a yes/no engineering fact, not a
product judgment call, so it's checked here rather than left open.

**Answer: no, not without a cluster-level change.** Queried Aurora's live
`pg_settings` directly (`vitana` database):

| Setting | Live value | Needed for logical replication |
|---|---|---|
| `wal_level` | `replica` | must be `logical` |
| `rds.logical_replication` | `off` | must be `1`/`on` (this is the RDS/Aurora parameter-group knob that gates `wal_level=logical` — Aurora doesn't take a plain `wal_level` override) |
| `max_replication_slots` | `20` | already sufficient |
| `max_wal_senders` | `20` | already sufficient |

Supabase's `realtime` server subscribes to `postgres_changes` via a logical
replication slot against a publication (`supabase_realtime`) — mechanically
identical to how DMS's own CDC leg reads Supabase's source database. With
`wal_level=replica`, Postgres cannot create a logical replication slot at
all (`ERROR: logical decoding requires wal_level >= logical` is the exact
failure this would hit). The cluster's DB cluster parameter group is
`vitana-aurora-pg17-prod` (engine 17.4, `available`) — `rds.logical_replication`
lives there, confirmed via `aws rds describe-db-clusters`, read-only.

**This is not a small flip.** `rds.logical_replication` is a *static*
Aurora parameter — changing it requires a full cluster reboot to take
effect, which briefly interrupts every connection this migration effort's
own DMS task, the RDS Data API access this session uses, and (if this
cluster is serving anything else already) any other consumer. It is also,
per this repo's own CLAUDE.md governance, a production infrastructure
change requiring its own VTID and is deliberately NOT made here — this
addendum only establishes the fact needed to make that decision correctly:
**option (a) is available, but its true cost includes "reboot
`vitana-aurora-prod`," not just "point `realtime` at a new connection
string."** That cost is a real input to the option (a) vs (b) call, not a
reason to default to (b) — a gateway-owned relay for 3 hot tables is its
own real build, not obviously cheaper than one reboot plus running an
existing, battle-tested open-source service.

## Addendum, 2026-08-28 — `exafyltd/vitana-mobile` checked: zero Supabase usage, out of scope

This doc's own "Not done in this pass" section (above) flagged that
`exafyltd/vitana-mobile` was never checked for independent Realtime
subscriptions. Checked directly this session (the repo is a local clone,
one commit, `pushed_at: 2025-10-22` — effectively unmaintained relative to
this migration's timeline).

**Zero `supabase_flutter` usage of any kind.** `pubspec.yaml` doesn't even
depend on the package; `grep -rn ".channel(" lib/` and `grep -rn
"Supabase\.instance" lib/` both return zero hits. The app is Firebase-based
(`firebase_core`, `firebase_auth`, `google_sign_in`), not Supabase-based.
**This closes the gap with a real answer, not just "checked and found
nothing to check"** — there is no Realtime surface in this app to migrate,
full stop. Confirmed a `supabase/migrations/` directory exists in the repo
root (one file, `20251022_oasis_ai_models.sql`) — a leftover from local
Supabase CLI scaffolding, not evidence of a running client integration.

**Unrelated but important finding from the same pass, flagged separately
in conversation (not detailed here — no secret material belongs in a
docs file):** this repo has a live-looking GCP service-account private key
hardcoded in source (`lib/modules/home/mixins/speech_recogination_mixin.dart`,
committed since 2025-10-22), authenticating Google Cloud Speech-to-Text
under a GCP project (`vitana-435310`) this migration effort's docs have
never named — a different project than the decommissioned
`lovable-vitana-vers1`. Out of scope for B5 and out of scope for this
session to remediate (needs GCP console access to rotate/revoke), but
recorded here so the "vitana-mobile: not checked" gap doesn't get closed
without this surfacing. See conversation history for the disclosure to the
platform owner.

## Addendum, 2026-08-29 — the option (a) vs (b) decision is not actually open: the plan's own Phase 1 choice already settles it

The prior addendum ended with "Still not decided here, deliberately: which
mechanism ... serves the three hot tables." Re-reading
`docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s own Phase 1 section shows
this framing undersells how far the decision already goes — it isn't a
fresh architecture call B5 gets to make independently, it's an instance of
a strategic choice the platform owner already made in writing on
2026-08-25, before this doc's own criticality addenda even existed:

> **DECIDED 2026-08-25: Option B.** The platform owner's standing directive
> — full migration off Supabase, **including the Auth server**, ending in
> Supabase being fully disconnected and downgraded to its free plan by
> 20 September 2026 — rules out Option A by construction: self-hosting the
> Supabase stack (even on AWS/Aurora) is still running Supabase, not
> shutting it down...

Option (a) here — "run Supabase's own open-source `realtime` binary,
pointed at Aurora, indefinitely, in production" — **is Option A's approach,
applied to exactly one of the five Supabase components the Phase 1 decision
already rejected wholesale.** It is not materially different from "self-host
GoTrue against Aurora," which the same decision explicitly named and ruled
out. Running a Supabase-authored server as a permanent piece of production
infrastructure fails the stated success criterion — "Supabase fully
disconnected... downgraded to free plan" — exactly as much whether the
component in question is Auth, Realtime, or anything else in the stack. The
fact that `realtime` is open-source and can technically be self-hosted
doesn't exempt it from a decision framed around *ownership*, not licensing.

**Conclusion: option (b) — a gateway-owned relay for the 3 hot tables
(`user_activity_log`, `user_notifications`, `chat_messages`) — is the only
choice consistent with the decision already on record.** This isn't a new
judgment call; it's applying the existing Option B decision to the one place
B5's own prior addenda had left it looking like an open architecture
question. No further sign-off is needed to say *which side* of the
mechanism choice is correct — only the actual build is separate, VTID-gated
execution work.

**One nuance the prior addendum's framing obscures, worth carrying into
that execution work:** the prior addendum's "true cost of option (a)
includes a cluster reboot" finding (`wal_level=replica` →`logical`,
`rds.logical_replication` off →on) is **not specific to running Supabase's
binary** — it is a precondition of *logical replication itself*. A
gateway-owned relay built the "obvious" way (subscribing to Aurora's WAL via
its own replication slot, the same mechanism DMS and Supabase's `realtime`
both use) would need the **identical** reboot; choosing (b) over (a) does
not, by itself, avoid it. Two real paths forward for the gateway relay,
genuinely different in cost:

1. **Gateway-owned logical-replication consumer** (e.g. via `pg_logical` /
   a Node client subscribing to a publication) — architecturally the
   closest to what `realtime` already does, but still needs the same
   `rds.logical_replication=on` reboot as option (a), so it does not dodge
   that cost, only the "running Supabase's own binary" objection.
2. **Gateway-owned polling relay** for just these 3 tables — short-interval
   `SELECT ... WHERE updated_at > $last_poll` (or an equivalent
   append-only/sequence-cursor read for `chat_messages`/`user_activity_log`,
   which look insert-heavy per the write-activity numbers above) fanned out
   to subscribed WebSocket/SSE clients from the gateway. Avoids the reboot
   entirely — the real reason this is worth calling out as its own option,
   not a lesser version of (1). At "Hot" tier write volumes (135k/67k/41k
   lifetime writes, not per-second), a poll interval in the low seconds is
   very likely tolerable for all three use cases (activity log, in-app
   notifications, chat) without the user-facing latency cost that would
   matter for something like collaborative cursors — but this is an
   assumption to validate against actual UX expectations before building,
   not a fact this pass measured.

Recommendation for whoever picks up B5 execution: **start with the polling
relay (path 2)** for the 3 hot tables — it is buildable and shippable
without any production infrastructure change (no VTID-gated reboot, no
governance sign-off beyond the relay code itself), fully consistent with
the Option B decision, and can be upgraded to logical-replication-based
push later (still gated on the same reboot decision, now isolated to one
clearly-scoped follow-up) if polling latency proves genuinely insufficient
once real usage is observed. This also sequences cleanly with B4 — a
gateway-owned relay needs to know which tenant/user each Aurora row belongs
to in order to fan out only to authorized subscribers, i.e. it needs the
same identity/session context B4 is already building, rather than
re-deriving RLS-equivalent authorization logic a second time.

## Execution update, 2026-09-11, VTID-03815 continuation — B5 execution started: `user_notifications` polling relay shipped, flagged off

Followed this doc's own recommendation above and started B5 execution with
path 2 (polling relay), on the simplest of the 3 hot tables first —
`user_notifications`, whose ownership model is a plain `user_id` +
`tenant_id` match (mirrors the scoping `notifications-repository.ts`'s
existing `fetchNotificationHistory()` already uses for the non-realtime
history endpoint). `user_activity_log` and `chat_messages` are NOT covered
by this pass — `chat_messages` in particular needs thread/group membership
checks, not just row ownership, and is real follow-up work, not an
oversight here.

**Shipped, same "ship the seam, don't flip it live" pattern as B6's
`STORAGE_PROVIDER` and B7's `AI_BRIDGE_PROVIDER`:**

- `services/gateway/src/services/realtime/user-notifications-relay-repository.ts`
  — cursor-based query (`created_at`/`id` tie-break, so no row is skipped
  or duplicated across polls even when several share a timestamp).
- `services/gateway/src/services/realtime/user-notifications-poller.ts` —
  pure polling logic (`pollNotificationsOnce` / `startNotificationPolling`),
  deliberately separated from any HTTP/SSE concern so it unit-tests without
  a live Supabase connection or an open connection. On a query error the
  cursor is left unchanged (retries the same window next tick) and the
  caller is notified via `onError` without the loop stopping — a transient
  Supabase blip shouldn't kill a live connection, matching the
  narration-audio-cache's "log loudly, degrade, keep going" posture
  elsewhere in this migration.
- `services/gateway/src/routes/realtime-relay.ts` — new
  `GET /api/v1/realtime/user-notifications/stream` SSE route,
  `requireAuth`+`requireTenant`, scoped to the caller's own
  `identity.user_id`/`tenant_id` (never a client-supplied id). Gated by
  `FEATURE_REALTIME_RELAY_USER_NOTIFICATIONS_ENV` — unset anywhere today,
  so `isFeatureLive()` resolves `off` and the route 404s before touching
  identity, Supabase, or opening a connection. Mounted at
  `/api/v1/realtime` in `index.ts`.
- Stream semantics: a cursor starting at connection time (not a backlog
  replay — `GET /notifications` already serves history for anything
  older), 3s poll interval, 30s heartbeat, and `req.on('close')` cleanup
  that stops the poller's `setInterval` — mirrors the existing
  `GET /reminders/stream` SSE route's conventions exactly rather than
  inventing a new shape.

**Explicitly not done, and not silently implied by "shipped":**
- No frontend consumer exists yet. Nothing today calls this endpoint from
  `vitana-v1` — wiring one up (and deciding whether a browser client uses
  a token-in-query-param `EventSource`, the same compromise
  `reminders.ts`'s own `/stream` route already documents needing, or an
  `Authorization`-header `fetch()` stream reader instead) is separate,
  later work.
- `user_activity_log`/`chat_messages` relays — not built, per the scoping
  note above.
- No live exercise against a real Supabase project — this session has no
  live Supabase credentials this pass (Supabase MCP unavailable
  mid-session, see this branch's VTID-03815 commits). 12 new unit tests
  (repository query shape, poller cursor-advance/error/stop semantics,
  route flag-gating) plus a full gateway suite re-run: 838/839 suites (1
  pre-existing skip), 14,331 tests passing, 0 failures; `tsc --noEmit`
  clean. Flipping the flag on and confirming a real poll cycle against
  live Aurora/Supabase data is the next real step, not assumed done here.

## Execution update, 2026-09-11 continued — `user_activity_log` added; the poller generalized rather than copy-pasted a second time

Immediately after the addendum above, added the second of the 3 hot
tables: `user_activity_log`. Its ownership model is even simpler than
`user_notifications`' — confirmed against both the read side
(`user-context-profiler-repository.ts`'s `fetchActivityLogRows()`) and the
write side (`timeline-projector.ts`'s `writeTimelineRow()`): the table has
**no `tenant_id` column at all**, so `user_id` alone is the full
authorization key.

**Refactor, not a second hand-copy:** `user-notifications-poller.ts` and
`user-notifications-relay-repository.ts` from the previous addendum are
**deleted**. Their cursor/polling/error-handling logic was byte-for-byte
what `user_activity_log` needed too, differing only in the table name and
which columns form the ownership filter — copying the whole file a second
time would have created the exact "five copies of the same table diverge"
failure shape this repo's own CLAUDE.md CHANGE LOG already names twice
(VTID-03644's language map, VTID-03696's workflow `paths:` list). Replaced
with one generic module,
`services/gateway/src/services/realtime/generic-cursor-relay.ts`:
`RelayTableConfig` takes a table name and a `filters` map of column→value
equality checks (`is(col, null)` when a filter value is `null`, `eq()`
otherwise), and `fetchRowsSinceCursor`/`pollRowsOnce`/`startRowPolling`
are unchanged in behavior from the table-specific versions, just
parameterized. `realtime-relay.ts`'s two routes now share one
`streamTable()` handler factory, differing only in their feature-flag
name, SSE `event:` name, and `buildConfig(identity)` closure.

**This generalization is scoped to "row ownership by column equality"
specifically — `chat_messages` will NOT fit it.** Thread/group membership
is a join, not a column match, so `chat_messages` needs its own
authorization logic layered on top (or instead of) this module when it's
built; forcing it through `RelayTableConfig.filters` would be the wrong
abstraction, not a shortcut.

**New:** `GET /api/v1/realtime/user-activity-log/stream`, same
`requireAuth`+`requireTenant` gating, scoped to `identity.user_id` only
(no tenant filter — there is no tenant column to filter on), gated by
its own independent flag `FEATURE_REALTIME_RELAY_USER_ACTIVITY_LOG_ENV`
(also unset everywhere today) so the two tables can graduate to
staging/prod independently of each other.

16 tests now (up from the prior addendum's 12 — the generic module's own
test file plus a parameterized `describe.each` route test covering both
endpoints identically). Full gateway suite re-run: 837/838 suites (1
pre-existing skip), 14,335 tests passing, 0 failures; `tsc --noEmit`
clean. `chat_messages` remains the one hot table with no relay at all —
the next real B5 step, and the one this module's own scoping note above
says needs a different approach, not an extension of this one.

## Execution update, 2026-09-11 continued — all 3 hot tables now have a relay: `chat_messages` shipped, flagged off

Closes out B5's own live-critical-table list. `chat_messages` shares one
table between two conversation shapes, confirmed directly against the
existing read paths rather than assumed: `chat-repository.ts` (direct
messages: `sender_id`/`receiver_id` columns, `group_id` NULL) and
`chat-groups-repository.ts` (group messages: `group_id` set, visibility
via `chat_group_members` membership — a JOIN, not a column match). This is
exactly the shape the previous addendum's scoping note predicted would
not fit `generic-cursor-relay.ts`, confirmed rather than just assumed —
so it did not go through that module.

**New, purpose-built module** (`services/gateway/src/services/realtime/
chat-messages-relay-repository.ts` + `chat-messages-poller.ts`):

- `fetchUserGroupIds()` — the caller's current `chat_group_members` rows.
  **Re-fetched on every poll tick**, not cached for the connection's
  lifetime, so a mid-session group join/leave is honored without
  requiring a reconnect — a real design choice, not an oversight; the
  extra query is cheap (indexed lookup by `user_id`) against the
  correctness cost of a stale membership snapshot.
- `fetchChatMessagesSinceCursor()` — visibility is `sender_id.eq.<me>
  OR receiver_id.eq.<me> OR group_id.in.(<my current groups>)`, ANDed
  (via a second, separate `.or()` call — Supabase/PostgREST ANDs multiple
  top-level filters together) with the same `created_at`/`id` cursor
  tie-break the generic module uses, so no message is skipped or
  duplicated across polls here either.
- `pollChatMessagesOnce()` short-circuits and reports the error (cursor
  held, same "retry the same window" posture as every other poller in
  this migration) if the group-membership lookup itself fails, without
  ever reaching the message query — a stale/wrong membership list would
  be a worse failure than no messages this tick.

**New route:** `GET /api/v1/realtime/chat-messages/stream`, same
`requireAuth`+`requireTenant` gating, gated by its own independent
`FEATURE_REALTIME_RELAY_CHAT_MESSAGES_ENV` (unset everywhere today).
`realtime-relay.ts`'s SSE boilerplate (headers, the `connected` event,
heartbeat, `req.on('close')` cleanup) was also extracted into one
`openSseStream()` helper at this point — with three routes now needing
the identical wiring, copying it a third time would have been the same
mistake the generic-poller refactor already fixed once for the polling
logic itself.

**All 3 tables `AURORA-B5-REALTIME-INVENTORY.md` identified as
genuinely live-critical now have a relay, all flagged off.** Total: 15
new tests for this increment (7 repository, 6 poller, 2 route) — 31
realtime-relay tests overall. Full gateway suite re-run: 839/840 suites
(1 pre-existing skip), 14,350 tests passing, 0 failures; `tsc --noEmit`
clean.

**Still explicitly not done:** no frontend consumer for any of the 3
routes (same gap named in the first addendum, unchanged); no live
exercise against real Supabase/Aurora data (this session has no live
Supabase credentials this pass); and the mechanism itself is still
unproven under real production message/notification/activity volume —
polling at a 3s interval per open connection is a reasonable starting
point per the base doc's own sizing numbers (135k/67k/41k lifetime writes
across the 3 tables, not per-second), but that is a documented assumption
to validate, not a measured fact. Flipping any of the three flags on
staging and confirming a real poll cycle end-to-end is the next real
step for whoever picks this up next.

## Execution update, 2026-09-11 continued — a first frontend consumer now exists in `exafyltd/vitana-v1` (built, tested, NOT wired into any component)

Closes part of the "no frontend consumer exists yet" gap the first
addendum named, for exactly one of the 3 routes:
`GET /api/v1/realtime/user-notifications/stream`. The other two
(`user-activity-log`, `chat-messages`) still have zero frontend code —
this is a first consumer, not a completion of this line item.

**`vitana-v1` additions** (same branch, `claude/aws-supabase-aurora-cutover-oxdie9`):

- `src/lib/sse-relay-client.ts` — a fetch-based SSE reader
  (`consumeSseRelay(url, jwt, opts)` + `parseSseChunk()`). Deliberately
  NOT `new EventSource(url)`: EventSource cannot send a custom
  `Authorization` header, and this route is `requireAuth`-gated on a
  bearer JWT, the same compromise `reminders.ts`'s own `/stream` route
  already documents (it falls back to `?user_id=` instead — this client
  takes the header route instead of following that precedent, since the
  gateway route here was built expecting `Authorization: Bearer`, not a
  query param). Parses `id:`/`event:`/`data:` framing, comment/heartbeat
  lines (`:`-prefixed), multi-line `data:` fields, and chunk boundaries
  that split an event across two reads — including CRLF-terminated input,
  which the first version of this parser did NOT handle correctly (see
  below).
- `src/hooks/useUserNotificationsRealtimeRelay.ts` — wraps the client in
  a reconnect loop (5s fixed backoff) and exposes
  `'idle'|'connecting'|'connected'|'error'`. **Not called from
  `useNotifications.ts` or any other component** — the backend flag is
  unset everywhere, so wiring it in today would just retry a 404 forever
  for zero benefit. Swapping it in for the existing Supabase Realtime
  `postgres_changes` subscription is a separate, later decision that
  needs the backend flag flipped and live-verified on staging FIRST, per
  this doc's own "next real step" above.
- 15 new vitest tests across both files (11 for the parser/client, 4 for
  the hook — connect/disconnect, event filtering, abort-on-unmount).
  `vitana-v1` full suite: 88/88 files, 413/413 tests passing;
  `tsc --noEmit` clean.

**A real bug was caught before shipping, by the CRLF-tolerance test
itself:** `parseSseChunk`'s first version split on a literal `'\n\n'`
substring, which never occurs in a CRLF-terminated stream (`'\r\n\r\n'`
has no bare `'\n\n'` inside it) — so a CRLF-framed SSE response would
never have parsed a single event. Fixed by normalizing all line endings
to `\n` before splitting, rather than weakening the test to dodge CRLF
input. This gateway's own SSE writer (`openSseStream()`, above) emits
LF-only today, so the bug was latent, not live — but the SSE spec permits
either terminator, and a proxy/CDN in front of the gateway rewriting line
endings was exactly the kind of failure this test was written to rule
out before it could happen silently in production.

**Still not done:** the other 2 relay routes have no frontend consumer at
all; the backend flags are still unset everywhere (unchanged); and this
hook itself has never been exercised against a live SSE stream — the
mock in its test suite stands in for `consumeSseRelay`, so the parser's
correctness against real gateway output is unverified until the backend
flag is flipped on staging and someone points a real browser at it.
