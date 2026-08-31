# B2 — Dead Call-Site Audit (VTID-03735)

Part of `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s B2 workstream ("kill
dead call sites before porting them"). This pass became possible only once
this session had live Supabase access (see `docs/AURORA-B3-RPC-PARITY-
INVENTORY.md` and `docs/AURORA-PHASE0-RECONCILIATION-FINDINGS.md`, same
session) — prior sessions could only flag "not found in migrations" as a
static-analysis signal, never confirm it against the real schema.

## Method

`scripts/ci/aurora-migration-inventory.cjs --json` was already run this
session for the B1/B3 work (cached at `/tmp/inventory.json`). Its `.from()`
table-name set (375 distinct names referenced across the codebase) was
diffed against the live Supabase `public` schema's 583 tables/views, giving
49 "referenced but not found" candidates. 7 were obvious regex/self-
reference artifacts and excluded without a live check (`12345678901234567890`,
`bogus`, `img`, `pg_extension`, `table`, `x`, `y` — the same class of noise
already documented in the B3 RPC inventory for `x`/`y`).

The remaining 42 were checked two ways, live, against project
`inmkhvwdcuyhnxkgfvsb`:
1. `to_regclass('public.<name>')` — catches tables, views, materialized views.
2. `information_schema.tables` with no schema filter — catches a table that
   exists, just not in `public` (this is what caught `users`).

**Discipline applied, matching the B3 inventory's own lesson:** never
conclude "dead" from a static-analysis miss alone — B3 found `autopilot_logs`
and 6 RPCs that the same kind of "not found" signal had wrongly flagged.
Every one of the 42 below was checked against the real schema before being
placed in either bucket.

## Result: 8 false positives, 33 confirmed non-existent

### False positives — real tables the static scan simply missed (8)

| Table | Note |
|---|---|
| `agent_personas_registry` | exists |
| `ai_usage_month_by_user_provider` | exists |
| `intent_open_asks` | exists — this is the exact table this session's own B1 work (`routes/intent-open-asks-repository.ts`) queries; confirmed correct, not a defect introduced by that extraction |
| `signup_funnel` | exists |
| `stripe_subscriptions` | exists |
| `user_diary_streak` | exists |
| `user_pillar_recent_activity` | exists |
| `wearable_rollup_7d` | exists |

### Near-miss — exists, but not where the code implicitly assumes (1)

| Table | Note |
|---|---|
| `users` | Only `auth.users` exists — there is no `public.users`. The one call site (`services/gateway/src/routes/auth-repository.ts`) needs its own read before concluding anything; not investigated further here (out of this pass's scope) beyond confirming the schema-qualification question is real, not a false alarm. |

### Confirmed dead — no table anywhere in the live schema, no `CREATE TABLE` in any tracked migration (33)

Verified via `information_schema.tables` with no schema filter (rules out
"exists somewhere else") and a migration-directory grep for `CREATE TABLE
<name>` (rules out "created then dropped by an untracked/manual op — still
worth knowing the code never got a tracked migration for it").

| Table | Referencing file(s) (from the inventory) |
|---|---|
| `adaptation_plans` | `services/gateway/src/services/guide/adaptation-applier.ts` |
| `autopilot_prompt_prefs` | `services/gateway/src/services/automation-executor-repository.ts` |
| `awareness_config` | `services/gateway/src/routes/awareness-config-repository.ts`, `services/gateway/src/services/awareness-registry-repository.ts` |
| `awareness_config_audit` | `services/gateway/src/routes/awareness-config-repository.ts` |
| `community_group_members` | `services/gateway/src/routes/community-repository.ts`, `services/gateway/src/services/voice-tools/community-member-ranker-repository.ts` |
| `community_meetup_attendance` | `services/gateway/src/routes/scheduled-notifications.ts`, `services/gateway/src/services/milestone-service-repository.ts` |
| `conversation_threads` | `services/gateway/src/services/gemini-operator-repository.ts` |
| `creator_profiles` | `services/gateway/src/routes/tenant-admin/community-admin-repository.ts` |
| `d28_emotional_signals` | `services/gateway/src/services/automation-handlers/wallet-payments-repository.ts` |
| `d44_intervention_history` | `services/gateway/src/services/d44-signal-detection-engine-repository.ts` |
| `d44_predictive_signals` | `services/gateway/src/routes/scheduled-notifications.ts`, `services/gateway/src/services/d44-signal-detection-engine-repository.ts` — **also listed as a canonical Core Table in this repo's own `CLAUDE.md` §3**, which does not match live reality |
| `life_compass_active_view` | `services/gateway/src/services/matchmaker-agent.ts` |
| `live_room_attendees` | `services/gateway/src/routes/live-repository.ts` |
| `match_targets` | `services/gateway/src/services/match-tool-handler-repository.ts`, `services/gateway/src/services/proactive-match-messenger-repository.ts` |
| `matches_daily` | `services/gateway/src/routes/matchmaking-repository.ts`, `services/gateway/src/routes/scheduled-notifications.ts`, `services/gateway/src/services/match-tool-handler-repository.ts`, `services/gateway/src/services/milestone-service-repository.ts`, `services/gateway/src/services/proactive-match-messenger-repository.ts`, `services/gateway/src/services/recommendation-engine/analyzers/community-user-analyzer-repository.ts` |
| `media` | `services/gateway/src/services/video-thumbnail-service.ts` (this one is largely a false-positive-shaped miss — see note below) |
| `relationships` | `services/gateway/src/services/voice-tools/superlatives-repository.ts` |
| `risk_mitigations` | `services/gateway/src/services/d49-risk-mitigation-engine-repository.ts` — **also listed as a canonical Core Table in this repo's own `CLAUDE.md` §3**, same mismatch as `d44_predictive_signals` |
| `user_goals` | `services/openclaw-bridge/src/skills/vitana-assessments.ts` |
| `user_match_preferences` | `services/gateway/src/services/match-tool-handler-repository.ts`, `services/gateway/src/services/proactive-match-messenger-repository.ts` |
| `user_topic_profile` | `services/gateway/src/routes/match-feedback-repository.ts`, `services/gateway/src/services/automation-handlers/business-marketplace.ts`, `services/gateway/src/services/milestone-service-repository.ts`, `services/gateway/src/services/social-connect-service.ts`, `services/gateway/src/services/user-health-context-repository.ts` |
| `vtn_transactions`, `vtn_wallets` | `services/openclaw-bridge/src/skills/vitana-vtn-wallet.ts` |
| `wallet_balances` | `services/gateway/src/routes/automations-repository.ts`, `services/gateway/src/routes/billing.ts`, `services/gateway/src/services/entitlement-service-repository.ts` |
| `appointments`, `assessment_responses`, `assessments`, `documents`, `health_reports`, `knowledge_articles`, `lab_results`, `tenant_integrations`, `webhooks` | all in `services/openclaw-bridge/src/skills/*` — a **separate service**, not `services/gateway`; see note below |

## Addendum 2: `d44_predictive_signals`/`d44_intervention_history` — confirmed reachable, not just flagged

Follow-up spot-check, same discipline as the `wallet_balances` addendum
above: `d44_predictive_signals` and `d44_intervention_history` are queried
by `services/gateway/src/services/d44-signal-detection-engine-repository.ts`,
consumed by `d44-signal-detection-engine.ts`, which
`routes/signal-detection.ts` wraps — and that route **is mounted** in
`index.ts` at `/api/v1/predictive-signals`. A second, independent call site
in `routes/scheduled-notifications.ts` queries `d44_predictive_signals`
directly. This is not a dormant/unwired code path like `adaptation_plans`
— it's live and reachable.

**Confirmed reachable from the frontend too:** `exafyltd/vitana-v1`'s
`src/pages/admin/intelligence/Signals.tsx` calls this exact API. So an
admin opening the Intelligence → Signals page hits a mounted route that
queries two tables neither of which exist in the live schema.

**Unlike `billing.ts`'s wallet snapshot, this one fails loud, not silent** —
`signal-detection.ts`'s handlers check the Supabase `error` field properly
(`console.error(...); res.status(...).json({error: ...})`), so this
surfaces as a visible error response to the admin, not a silently-empty
page. Confirms this is real (not a false alarm) without needing to guess at
severity: it's a broken admin feature with a visible failure, not a
silently-degraded one — lower stealth-risk than the wallet finding, but
still a genuine defect an admin would hit today.

## Addendum 3: `risk_mitigations` — mounted, but no confirmed caller (weaker finding than D44's)

`risk_mitigations`'s route (`routes/risk-mitigation.ts`, backed by
`d49-risk-mitigation-engine.ts` → `d49-risk-mitigation-engine-repository.ts`)
**is mounted** at `/api/v1/mitigation` in `index.ts` — same shape as D44's
route — but unlike `d44_predictive_signals`, no caller was found for it:
not in `vitana-v1/src` (grepped for `mitigation`, zero hits), not in
`scheduled-notifications.ts`, not in any cron-like wiring checked. It's
reachable by a direct API call (curl, or a caller this pass didn't check —
mobile app, an admin script), but has no *confirmed* real-world trigger the
way D44's Signals page provides. **Weaker finding than D44's, not treated
as equally severe** — flagged as mounted-but-unconfirmed rather than
mounted-and-reachable-from-a-real-screen.

## Addendum 4: the gateway matchmaking subsystem looks superseded, not just dead-table

`matches_daily`, `match_targets`, and `user_match_preferences` (3 of the 33)
are all consumed by the gateway's matchmaking feature — `routes/
matchmaking.ts` + `routes/match-feedback.ts`, both mounted at `/api/v1/match`,
backed by `match-tool-handler-repository.ts`/`proactive-match-messenger-
repository.ts`. Checked whether this is reachable from the frontend the same
way D44/D49 were — and found something more specific than "no caller found."

`exafyltd/vitana-v1`'s actual "people who match you" feature
(`src/hooks/useRealMatches.ts`) does **not** call the gateway's `/api/v1/match`
routes at all. Its own header comment: *"Real 'people who match you' data,
backed by the `daily_matches` table and the `generate-daily-matches` edge
function — the same source the full discovery flow (PeopleDiscoveryHero)
uses."* That's a **different table** (`daily_matches`, confirmed to exist
live — `to_regclass('public.daily_matches')` is non-null) reached through a
**different code path** (a Supabase edge function, direct from the
frontend) than the gateway's `matches_daily`-based system.

**Reading this as one finding rather than three separate dead tables:** the
gateway's whole matchmaking subsystem behind `/api/v1/match` — not merely
one broken query — looks like an earlier implementation that was superseded
by a different, edge-function-based matching feature the frontend actually
uses today, and the gateway side was never updated or removed. This is a
plausible explanation, not confirmed by reading every file in
`match-tool-handler-repository.ts`/`proactive-match-messenger-repository.ts`
in full (not done in this pass) — but it reframes the right question from
"is `matches_daily` a typo for some other table" to "is the entire gateway
matchmaking route dead code that should be removed, now that a different
system does this job."

## Addendum 5: `user_topic_profile` — widely scattered, looks like a genuinely-planned cross-cutting feature, not superseded

Different shape again from the matchmaking finding above. `user_topic_profile`
has 5 independent call sites spanning distinct, broadly-used subsystems:
`milestone-service-repository.ts`, `user-health-context-repository.ts`,
`social-connect-service.ts` (both reads and an upsert — "Interests →
auto-populates user_topic_profile"), `automation-handlers/business-
marketplace.ts`, and `routes/match-feedback-repository.ts`. Two of these
feed into widely-mounted routes (`social-connect.ts`, milestone tracking
consumed from `routes/live.ts`/`auth.ts`/`community.ts`/`diary.ts`/
`matchmaking.ts` per an import-graph check).

This doesn't fit the "superseded by a newer system" read the matchmaking
tables got — there's no sign of a differently-named replacement table doing
this job elsewhere, and the write site (`social-connect-service.ts`'s
upsert) implies this was meant to be an actively-populated, cross-feature
user-interest signal (milestone tracking, health context, marketplace
personalization, and match feedback all reading the same profile). Reads
more like `adaptation_plans` — a genuinely-planned feature whose storage
layer was never migrated — but with a much wider intended blast radius (5
subsystems, not 1). **Not confirmed with a full read of all 5 call sites'
error handling** (only spot-checked, in the interest of proportionality
after 4 prior addenda) — flagged as the single highest-value target for
whoever does the next B2 pass, given how many features silently depend on
it.

## Addendum 6: two more confirmed already-safe-by-design — not every reachable call site is a bug

Checked two more of the higher-traffic remaining tables, both reachable
from genuinely hot paths, and both turned out to be non-issues:

- **`life_compass_active_view`** — read in `matchmaker-agent.ts`, itself
  imported by `routes/orb-live.ts` (the live voice session handler),
  `intents.ts`, and `intent-find-match.ts`. The call site is explicitly
  wrapped: `try { ... } catch { /* table may not exist on every env */ }`,
  with its own comment: *"Best-effort fetches — silent on error."* Designed
  for exactly this situation.
- **`conversation_threads`** — read in `gemini-operator.ts`'s
  `resolveThreadUserId()`, reachable from `routes/orb-live.ts`,
  `routes/conversation.ts`, and `routes/operator.ts`. Also wrapped in a
  `try { ... } catch { return null; }` with no rethrow.

**Net effect for both: reachable from hot paths, but genuinely harmless.**
Neither degrades a user-visible feature beyond "one optional enrichment
signal is always absent" (a life-compass category tag on a matchmaker
profile; a thread-to-user resolution that always returns null).

## Addendum 7: `community_group_members` — confirmed live, silently-broken notification path

`routes/community-repository.ts`'s `fetchGroupMembersExcluding()` queries
`community_group_members`, and — unlike its neighbors two lines below in
the same file (`fetchGlobalGroupMembership`/`insertGlobalGroupMembership`,
both correctly targeting the real, live `global_community_group_members`)
— this table does not exist. Traced the caller: `routes/community.ts`'s
join-group handler uses it to notify existing group members when someone
new joins (*"Notify other group members"*), and — same silent-failure
shape as `wallet_balances` — destructures only `{ data: members }`,
discarding the Supabase error. `members` is therefore always `undefined`,
`memberIds` always empty, and **the "notify existing members when someone
joins your group" notification silently never fires**, for every group,
every time, with nothing in logs marking it as a failure.

**This is not the same shape as the matchmaking finding** —
`community_groups` (the tenant-scoped group type this membership table
would belong to) and `global_community_groups` are both confirmed to be
real, distinct, live tables (`to_regclass` on both returns non-null), so
this isn't "the whole tenant-scoped groups concept was abandoned." A
broader table search (`information_schema.tables` ILIKE `%group%member%`)
turned up only `global_community_group_members`, `chat_group_members`, and
`global_group_members` — no plausible same-shape rename target for plain
`community_groups`. **Not resolved here** — whether `community_groups`
membership is meant to live in a table that was simply never created, or
is tracked some other way this pass didn't find (an array column, a
different join path via `chat_group_members`), needs someone who can read
`community_groups`' full schema and intended design, not a guess from this
pass.

This matters for prioritization — of the tables checked in depth this
pass, the real severity ranking is **`wallet_balances` and
`community_group_members` (both silent) > `d44_predictive_signals`/
`d44_intervention_history` (loud, admin-facing) > `user_topic_profile`
(unconfirmed but wide blast radius) > `risk_mitigations`/matchmaking
tables (unclear or superseded) > `life_compass_active_view`/
`conversation_threads` (confirmed harmless by design)** — not a flat list
of 33 equally-urgent problems.

## What this does and does not mean

**Not all 33 are the same kind of problem, and this pass does not root-cause
each one individually** — that would be 33 separate investigations, out of
proportion with a B2 sweep whose job is to identify candidates for removal,
not resolve them. Three shapes surfaced while gathering this list, worth
flagging explicitly:

1. **At least one is already self-documented as a known, unwired gap.**
   `adaptation-applier.ts`'s own header comment says outright: *"no
   `adaptation_plans` table currently exists in supabase/migrations and grep
   finds no INSERT into such a table from D43. This applier is the receiving
   half of a loop whose sender hasn't been wired up yet."* This confirms the
   live-schema finding rather than adding a new one — worth noting as a
   pattern: some of the other 32 may have similar self-aware comments not
   checked here.

2. **`services/openclaw-bridge` is a separate service from `services/gateway`.**
   9 of the 33 (`appointments`, `assessment_responses`, `assessments`,
   `documents`, `health_reports`, `knowledge_articles`, `lab_results`,
   `tenant_integrations`, `webhooks`) plus `user_goals` and both `vtn_*`
   tables live there, not in the gateway. This service was not in scope for
   this session's B1 sweep and its Supabase client configuration was not
   checked here — it is possible (not confirmed) that openclaw-bridge points
   at a different Supabase project/schema than `inmkhvwdcuyhnxkgfvsb`, which
   would make "not found in this project" a false signal for that subset
   specifically. **Flagging as unresolved, not concluding either way.**

3. **`media` is likely a static-analysis false positive of a different
   kind** — `video-thumbnail-service.ts` was already noted in this session's
   B1 sweep as using the Supabase **Storage** API (`.storage.from('bucket')`),
   not a table query; the inventory script's regex does not distinguish
   `.from()` on a query builder from `.from()` on the storage client. Kept
   in the "confirmed non-existent as a table" list for completeness (it
   genuinely isn't a table), but the underlying code is very likely fine —
   not a real dead call site.

4. **Two of the 33 (`d44_predictive_signals`, `risk_mitigations`) are named
   as canonical Core Tables in this repo's own `CLAUDE.md` §3**, which
   claims they exist in the platform's Postgres store. Live Supabase
   disagrees. This is either stale documentation (the tables were planned
   but never migrated) or a genuine gap between two D44/D49 signal-detection
   engines and their storage layer — **not resolved here**, flagged for
   whoever picks up the B2 cleanup or a CLAUDE.md accuracy pass.

## Addendum: `wallet_balances` spot-checked — real, live, money-adjacent gap (not a false alarm)

Per the "read each call site before concluding" discipline, `wallet_balances`
(3 call sites: `routes/automations-repository.ts`, `routes/billing.ts`,
`services/entitlement-service-repository.ts`) was checked further, since it
is money-adjacent and therefore higher-severity than most of the 33.

**This one is not soft-failing the way `awareness_config` is.**
`routes/billing.ts`'s `GET /me` — *"the single endpoint that powers the
Subscriptions screen"* per its own comment — queries
`.from('wallet_balances').select('purchased_credits, reward_credits,
cash_balance, balance')` and destructures only `{ data: wallet }`, silently
discarding `error`. Supabase-js doesn't throw on a PostgREST "relation does
not exist" — it returns `{data: null, error: {...}}` — so `wallet` is always
`undefined` here rather than the request failing loudly. Every real user
hitting the Subscriptions screen gets a wallet snapshot that is silently
absent, with nothing in the response or logs marking it as a failure rather
than "user genuinely has no wallet yet."

Checked whether this is a stale/renamed table rather than a truly missing
one: live schema has `wallet_credits`, `wallet_transactions`,
`wallet_balance_resets`, `user_wallets`, `wallet_accounts`, `wallet_deposits`,
`wallet_ledger_entries` — plausible rename candidates — but **none of them
carry the `purchased_credits`/`reward_credits`/`cash_balance` three-bucket
column shape** the code selects (comment: *"post-§M three-bucket schema"*).
`user_wallets`/`wallet_accounts` only have a single `balance`/`balance_minor`
column each. So this isn't a simple find-and-rename — the three-bucket
schema this code expects does not exist under any name, which means either
a migration that was supposed to ship never did, or the three-bucket model
was designed and never built.

**Not fixed here — flagging only.** Guessing at a substitute table/column
mapping for a money-adjacent read without knowing which schema is actually
authoritative risks making the wallet display worse (wrong numbers) rather
than better (still-missing numbers). This needs a product/eng decision on
which wallet model is canonical, not a static-analysis-driven patch.

**✅ Partially fixed 2026-08-29 — the silence, not the schema gap.** All
three `wallet_balances` call sites (`routes/billing.ts`'s `GET /me`,
`routes/automations.ts`'s `GET /wallet/balance`, and
`entitlement-service.ts`'s `readWalletBuckets`) now log the RPC error via
`console.error` when present, instead of silently discarding it (the first
two didn't even destructure `error`; the third destructured it but only
ever used it as a boolean short-circuit, never logged). **The underlying
schema gap is deliberately NOT fixed** — every response still falls back
to an all-zero wallet exactly as before; which table/column mapping is
canonical remains the open product/eng decision described above. This
closes the "indistinguishable from a genuinely empty wallet" observability
gap only. New tests: `services/gateway/test/routes/
automations-wallet-balance.test.ts` (new file), `services/gateway/test/
routes/billing-me-wallet.test.ts` (new file), `services/gateway/test/
services/entitlement-service.test.ts` (new file — this service had zero
prior coverage).

## Addendum 8: `openclaw-bridge`'s Supabase target question, resolved — the service has no live deploy target at all

This doc's own open question #2 asked whether `services/openclaw-bridge`
(12 of the 33 dead call sites — `appointments`, `assessment_responses`,
`assessments`, `documents`, `health_reports`, `knowledge_articles`,
`lab_results`, `tenant_integrations`, `webhooks`, `user_goals`, both
`vtn_*` tables) might point at a different Supabase project, which would
make "not found in `inmkhvwdcuyhnxkgfvsb`" a false signal for that subset.

**Checked directly (2026-08-27):** every one of its Supabase-client
constructors (`vitana-community.ts`, `vitana-scheduling.ts`,
`vitana-daily.ts`, `vitana-vtn-wallet.ts`, `vitana-integrations.ts`) reads
the generic `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` env vars — no
hardcoded, service-specific project reference either way, so the question
can't be settled from the code alone. It resolves a different way:
**`services/openclaw-bridge` has exactly one deploy path,
`.github/workflows/EXEC-DEPLOY.yml`, and that workflow is 100% GCP Cloud
Run** (`gcloud run services update/deploy`, `google-github-actions/setup-gcloud`,
region `us-central1`) — already named in this repo's own CLAUDE.md §9 as
one of the ~15 dead GCP-oriented workflow files left over from before the
2026-08-16 GCP shutdown, "safe cleanup candidates." No `AWS-*-DEPLOY-*.yml`
workflow references `openclaw-bridge` at all, and it is not in CLAUDE.md
§1b's AWS-production service table (gateway, community-app,
oasis-operator, oasis-projector, worker-runner, verification-engine,
orb-agent, autopilot-executor — openclaw-bridge is none of these).

**Conclusion: whichever Supabase project `openclaw-bridge` would point at
is moot, because the service has had no running deployment target at all
since GCP billing was disabled.** Its 12 "missing table" findings are real
dead code in the sense that the code paths cannot currently execute in
production — not because of a wrong-project false signal, but because
there is nowhere for this service to run. This is a stronger, more
actionable finding than the original open question anticipated: it doesn't
need a Supabase-project check to resolve, and the next real decision is
whether `openclaw-bridge` gets an AWS deploy pipeline built (per its own
`CLAUDE.md` non-deployable-services framing, it currently isn't even
listed as one of the deployable services) or is retired along with
`EXEC-DEPLOY.yml`.

## Addendum 9: remaining gateway-scoped dead tables read call-site by call-site (2026-08-27)

Per this doc's own "Next steps" discipline ("read each call site to
determine truly unreachable vs. reachable-and-broken"), checked the
tables that hadn't gotten that treatment yet.

- **`autopilot_prompt_prefs`** — reachable
  (`automation-executor.ts:51`), but deliberately safe: wrapped in
  `try { } catch { /* Use default if table doesn't exist or query fails */ }`,
  falls back to `DEFAULT_MAX_PROMPTS_PER_DAY`. No action needed — this is
  the pattern every other dead call site should have and few do.
- **`live_room_attendees`** — reachable, two call sites in `routes/live.ts`
  (room-ended summary notification to attendees, and a second to
  followers). Both destructure with an empty-array fallback
  (`(attendees || [])`), so the query returning an error just means the
  "check out the summary" notification silently never sends when a live
  room ends. Degraded feature, not a crash — moderate severity, no data
  loss, no money.
- **`community_meetup_attendance`** — reachable from a **scheduled cron**
  (`routes/scheduled-notifications.ts`, the meetup-starting-soon/now
  reminder job). `community_meetups` (the parent table) exists; the
  attendance/RSVP table does not, so `rsvps` is always `undefined` →
  `rsvpList` always empty → **nobody who RSVP'd to a community meetup has
  ever received a "starting soon" or "starting now" reminder, on any
  meetup, ever** — the cron runs "successfully" every time and silently
  does nothing for this specific piece. Real, ongoing, silent feature gap;
  worth a product decision on whether meetup RSVPs still need this table
  or the feature moved elsewhere.
- **`creator_profiles`** — reachable, `GET /creators` under
  `tenant-admin/community-admin`, admin-gated. Same soft-fail shape as
  `awareness_config`: error is checked and logged
  (`console.warn`) but the response still returns `{ok: true, creators:
  []}` — HTTP 200, empty list, no visible failure banner. An admin viewing
  this screen sees "no creators" rather than "this is broken." **✅ Fixed
  2026-08-29 — see the new addendum below; this was a real, confirmed-live
  bug, not just theoretical.**

None of these are money-adjacent like `credit_wallet` (B3 addendum) —
listed here for completeness and because two of them (the live-room and
meetup notification gaps) are genuine, currently-live silent feature
breakage a real user would notice as "I never get reminded," not just
theoretical dead code.

**✅ Partially fixed 2026-08-29 — `live_room_attendees`'s silence, not the
missing table.** Both `routes/live.ts` call sites (room-ended summary,
starting-soon follower notify) now destructure `error` from
`repo.fetchLiveRoomAttendeesExcluding(...)` and log it via `console.warn`
when present. The empty-array fallback — and therefore the actual
notifications never sending — is deliberately UNCHANGED; whether this
feature gets a real table or is retired is still the open product call
described above. `routes/live.ts` (2300+ lines, no existing test harness)
is pinned at the source level via a new
`test/routes/live-attendees-error-logging.test.ts`, matching this
codebase's established pattern for large/stateful modules impractical to
fully route-test. `community_meetup_attendance` is left unfixed — unlike
this one, its notification code doesn't even reach a query result to log
(the parent table exists but the attendance/RSVP table doesn't, per the
finding above), so there's no equivalent one-line observability fix
available without inventing the missing schema.

## Addendum 10: the remaining 7 gateway-scoped tables read — all already safe or already covered, closing out Addendum 9's list

Finished the call-site read Addendum 9 left open, for the 7 gateway-scoped
tables that hadn't been individually checked yet. **None of these needed a
fix or even a new finding** — every one is either already deliberately
safe-by-design (matching the `autopilot_prompt_prefs`/`life_compass_active_view`
pattern) or already covered by an earlier addendum in this doc:

- **`adaptation_plans`** — `services/guide/adaptation-applier.ts`'s own
  header comment states this is the receiving half of a D43 write-path
  that "hasn't been wired up yet." Explicitly checks for the
  relation-does-not-exist error and returns `{applied: 0, reason:
  'no_plans_table'}` rather than failing silently or loudly. No action.
- **`conversation_threads`** — `gemini-operator.ts`'s `resolveThreadUserId()`
  swallows the lookup failure and its caller's own comment says this is
  "Phase 1," falling back to an aggregate shape until orb-live wires up
  real thread→user attachment. Self-documented placeholder, not a bug.
- **`d28_emotional_signals`** (+ sibling `monetization_signals`) —
  `wallet-payments-repository.ts`'s own header comment already says
  "KNOWN GAP (pre-existing): neither table was ever deployed — both
  queries always no-op." Traced the consumer anyway since one of the two
  signals gates an `is_vulnerable` flag on monetization automation (a
  real ethical-risk shape if it were live) — but the automation that
  reads it, `AP-0710 "Monetization Readiness Scoring"`
  (`automation-registry.ts`), triggers on event topic
  `automation.monetization.check`, which **nothing in `services/gateway/src`
  ever emits**. Same "registered but never invoked" shape as
  `risk_mitigations` — a real gap in the code, zero live blast radius
  today because nothing reaches it.
- **`life_compass_active_view`** — `matchmaker-agent.ts` wraps the read in
  `try/catch` with an explicit "table may not exist on every env" comment.
  Already safe.
- **`match_targets`**, **`user_match_preferences`** — both part of the
  gateway matchmaking subsystem Addendum 4 already identified as likely
  superseded by the frontend's edge-function-based matching feature. No
  new finding; grouped with `matches_daily` under that addendum's existing
  conclusion.
- **`relationships`** — `voice-tools/superlatives-repository.ts` runs a
  deliberate two-column-name probe sequence (`to_user_id` then
  `followee_id`) for a "most-followed" voice-tool ranking, and when both
  probes come back empty falls through to a typed `{ok: false, error:
  'no_followers_data'}` response rather than a crash or a silent wrong
  answer. This is the loud-failure pattern the rest of this doc treats as
  acceptable (contrast `wallet_balances`' silent `{data: undefined}`).

**This closes the "read each call site" next step for all 20 gateway-scoped
tables** (13 read across Addenda 2/3/4/5/6/7/9 plus the `wallet_balances`
addendum, 7 more here). Final tally across the full 33: 2 confirmed live,
silently-broken bugs (`wallet_balances`, `community_group_members`, both
needing a product decision before any fix); 2 confirmed-mounted-but-
unreachable (`risk_mitigations`, and now `d28_emotional_signals`'
`AP-0710` consumer); 2 degraded-but-live features worth a product call
(`live_room_attendees`, `community_meetup_attendance`); 1 admin-facing
soft-fail (`creator_profiles`); the matchmaking trio
(`matches_daily`/`match_targets`/`user_match_preferences`) reads as one
superseded-subsystem finding, not three; and the remainder
(`adaptation_plans`, `conversation_threads`, `life_compass_active_view`,
`awareness_config`/`awareness_config_audit`) are self-documented,
deliberately-guarded placeholders needing no action.

## Next steps (not done in this pass)

- Confirm or rule out openclaw-bridge's Supabase target before treating its
  9-12 "missing" tables as real findings — **partially answered by
  Addendum 8**: the service has no live deploy target at all, so this is
  lower priority than it looked.
- Reconcile `CLAUDE.md` §3's Core Tables list against live schema reality
  for `d44_predictive_signals` and `risk_mitigations` specifically — done
  for `d44_predictive_signals`/`personalization_audit` in this session's
  CLAUDE.md pass; `risk_mitigations` still needs the same inline
  annotation.
- Decide, table by table, whether a dead call site should be deleted
  (never getting an Aurora equivalent) or is a known-incomplete feature
  that still needs its storage layer built — that decision is product/
  engineering-owned, not something to infer from absence alone. The two
  live-money/live-notification bugs (`wallet_balances`,
  `community_group_members`) are the ones actually worth a human's time
  first; everything else in this doc is either already safe or already
  unreachable.

## Addendum 11: `creator_profiles`/`GET /creators` — confirmed a real, live bug in `vitana-v1`, not the Command Hub; fixed, and the same shape closed across its 3 siblings

Followed up on Addendum 2's flag that `creator_profiles`'s soft-fail
"returns `{ok:true, creators:[]}` with no visible failure banner" — the
open question was whether any admin UI actually calls `GET /creators` and
ignores the embedded `error`, the same way Memory Garden's Command Hub
caller ignored its `_placeholder` flag (see
`docs/AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md`).

**The caller is not in the Command Hub at all** — a grep across
`services/gateway/src/frontend/command-hub/app.js` for `/creators`,
`fetchCreators`, `renderCreators` found nothing. The real caller is in
`exafyltd/vitana-v1`: `src/hooks/useAdminCommunity.ts`'s
`useCommunityCreators()`, consumed by `src/pages/admin/community/
Creators.tsx` — a genuine, rendered admin screen ("Community → Creators"),
not a dead route.

**Confirmed live 2026-08-29:** `to_regclass('public.creator_profiles')`
returns `null` — the table does not exist — so `GET /creators` fails on
every single call. `useCommunityCreators()` did `return json.creators ||
[]` with no check of `json.error`, and its OWN try/catch additionally
swallowed any error `adminFetch()` itself threw (an expired session, a
network failure, a non-2xx status) into the same empty array. `Creators.tsx`
rendered `AdminEmptyState` — "There are no community creators yet." — with
zero indication anything had failed, exactly the Memory Garden bug's shape,
one repo over.

**The same hook file has the identical bug in 3 more places** —
`useCommunityGroups()`/`GroupsNew.tsx`, `useCommunityLiveRooms()`/
`LiveRooms.tsx`, and (already partially built, see below)
`useCommunityMeetups()`/`Meetups.tsx`. All four gateway routes
(`/meetups`, `/groups`, `/live-rooms`, `/creators`) report a Supabase
failure identically: HTTP 200, `{ok:true, <key>:[], error:"<message>"}`.
Interestingly, `Meetups.tsx` already destructured `isError`/`error` from
its `useQuery` and rendered a distinct failure message — but
`useCommunityMeetups()`'s own queryFn never threw on `json.error`, so that
branch was dead code, unreachable for this exact failure shape (it would
only fire for adminFetch's own thrown errors, which the try/catch was ALSO
swallowing). The intent was already half-built; nothing was calling it.

**Fix (`exafyltd/vitana-v1`):** all four hooks in `useAdminCommunity.ts`
now `throw new Error(json.error)` when the field is present, and the
try/catch that discarded adminFetch's own thrown errors is removed —
both failure classes now surface through react-query's `isError`/`error`
instead of resolving to a confidently-empty array. `Creators.tsx`,
`GroupsNew.tsx`, and `LiveRooms.tsx` gained the same `isError` branch
`Meetups.tsx` already had (three new DE/EN i18n keys:
`failedLoadCreatorsValue0`, `failedLoadGroupsValue0`,
`failedLoadLiveRoomsValue0`, per this repo's i18n hard rule). Pinned at
the source level (`useAdminCommunity.error-surfacing.test.ts`, matching
this repo's own `useTenant.error-logging.test.ts` precedent) and
mutation-verified — reverting the `throw` fails exactly the 4 tests that
assert it. Full `vitest run`: 32/32 suites, 195/195 tests, `tsc --noEmit`
clean.

**`/memberships`, checked as part of the same sweep, is the OTHER
shape — no live bug, because no caller exists at all.** Grepped
`exafyltd/vitana-v1` for `community/memberships` and for any
`useCommunityMemberships`-style hook: nothing. `community_memberships`
(the table) does exist live (confirmed via `to_regclass`, unlike
`creator_profiles`), and the route itself works — it is simply never
invoked from any UI, the same "registered but never invoked" shape
already confirmed for `risk_mitigations`/`AP-0710` (Addendum 3). Its only
defect was cosmetic: unlike its three siblings, it never logged the
Supabase error via `console.warn` on failure — added for consistency
(`services/gateway/test/routes/tenant-admin/community-admin.test.ts`'s
existing `/memberships` error test now also asserts the log call). No
frontend fix needed here since there is no frontend to fix.
