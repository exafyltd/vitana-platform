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

## Next steps (not done in this pass)

- For the 20 genuinely gateway-scoped dead tables (33 total, minus the 12
  that live in `services/openclaw-bridge` — the 9 listed plus `user_goals`
  and both `vtn_*` tables — minus `media`, which is very likely a Storage-
  API false positive rather than a real dead table reference), read each
  call site to determine: truly unreachable (dead route, disabled feature flag,
  never-invoked function) vs. reachable-and-broken (a real production bug
  masked by an error path nobody noticed — the `awsdms_validation_failures_v1`
  and `n_live_tup` lessons from Phase 0 both showed that "nobody's
  complained" and "definitely fine" are not the same thing).
- Confirm or rule out openclaw-bridge's Supabase target before treating its
  9-12 "missing" tables as real findings.
- Reconcile `CLAUDE.md` §3's Core Tables list against live schema reality
  for `d44_predictive_signals` and `risk_mitigations` specifically.
- Decide, table by table, whether a dead call site should be deleted
  (never getting an Aurora equivalent) or is a known-incomplete feature
  that still needs its storage layer built — that decision is product/
  engineering-owned, not something to infer from absence alone.
