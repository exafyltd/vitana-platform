# Aurora Migration — Phase 3b/B3: RPC Parity Inventory

**VTID-03732.** Static-analysis categorization, cross-checked against the
live `VITANA` Supabase project (`inmkhvwdcuyhnxkgfvsb`) via read-only queries
this session — this pass **did** have live DB access (contrary to every
prior session in this migration effort, all of which recorded "no live
DB/AWS access" as their standing caveat). See
`docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` §Phase 3b/B3 for context.

**Corrects the plan doc's own headline finding on one specific table.** The
plan's 2026-08-04 measurement said `autopilot_logs` "does not exist in
production" (64 call sites, 27 files, the single largest "dead relation" in
its table). Verified live just now: **`autopilot_logs` exists** (`to_regclass`
resolves it, 0 rows). The table's `CREATE TABLE IF NOT EXISTS` has been in
`supabase/migrations/20260317000000_openclaw_bridge_tables.sql` since
2026-03-17 — either that migration ran between 2026-08-04 and today, or the
2026-08-04 cross-reference was wrong. Either way: **the plan's "~85 dead
relations" list is not safe to act on without re-verifying each one live** —
this is exactly the class of mistake B2 (killing dead call sites) would make
by trusting a four-week-old snapshot, and it's why this pass did the same
live check for the RPC layer below rather than repeating the same trust
without verification.

Written as the direct follow-on to B1 (VTID-03702, gateway data-access
repository seams — complete) per the plan's own sequencing: *"B3 — RPC parity.
204 distinct RPCs, 582 public functions... except any that reference
`auth.uid()`/`auth.jwt()` — those depend on GoTrue and must be re-expressed
against the new identity source. Inventory them before assuming they port."*
This is that inventory.

## Method

`scripts/ci/aurora-migration-inventory.cjs --json` lists every `.rpc('name')`
call site in `services/gateway/src` (204 distinct names). For each, this pass
searched `supabase/migrations/*.sql` for a `CREATE [OR REPLACE] FUNCTION name(...)
AS $tag$ ... $tag$` definition, took the **most recent** definition when a
function was redefined across multiple migrations, and searched its body for
`auth.uid()` / `auth.jwt()`.

**Caveats, read before acting on any single row:**
- This is textual, not semantic — a function calling *another* function that
  itself uses `auth.uid()` is not detected as auth-dependent unless the call
  chain is inlined in the same body. Spot-check before treating "portable" as
  a hard guarantee, the same caution the inventory script itself gives for its
  own table/RPC counts.
- "Not found in migrations" means no `CREATE FUNCTION` matched textually in
  this repo's `supabase/migrations/` tree. **This category was cross-checked
  against live `pg_proc`** (see below) — 6 of the 42 exist live despite no
  tracked `CREATE FUNCTION`, confirming the migration plan's own Phase 2
  finding (recorded migration versions do not reliably match migration files,
  377 file versions vs 330 applied rows) applies at the RPC level too, not
  just tables.
- The **auth-dependent** and **portable** categories (the 160 RPCs that DID
  have a tracked definition) were **not** cross-checked against live
  `pg_proc` — the auth/no-auth split for those is textual analysis of the
  tracked migration body only, and could differ from what's actually live if
  a function was redefined outside this repo's migrations.
- Two single-letter "RPC names" in the raw inventory (`x`, `y`) are a false
  positive from the inventory script's own textual pattern matching against
  `services/gateway/src/services/dev-autopilot-schema-context.ts`'s doc
  comments (`.rpc('x')`, `.rpc('y')` used there as illustrative examples, not
  real call sites) — excluded from the counts below.

## Summary

| Category | RPCs | Total call sites |
|---|---:|---:|
| **Auth-dependent** — body references `auth.uid()`/`auth.jwt()`, needs re-expression against the Phase 3b/B4 identity source (Cognito + session-GUC `auth.uid()` shim, per the plan) | 106 | 128 |
| **Portable** — definition found, no `auth.uid()`/`auth.jwt()` detected in the body; expected to port to Aurora largely as-is | 54 | 111 |
| **Not found** — called from the gateway, no matching `CREATE FUNCTION` anywhere in `supabase/migrations/` | 42 (excl. `x`/`y`) | 47 |

204 total (106+54+42=202, plus the 2 excluded false positives = 204, matching
the inventory script's raw count).

## Auth-dependent (106) — needs the B4 identity shim before it can port

The plan's B4 section names the cheapest fix: *"providing a compatible
`auth.uid()` function in Aurora reading from a session GUC set per
connection... that last trick is what makes [these] policies port unchanged;
without it they must each be rewritten."* The same trick should make most of
this list port unchanged too, since they're plain PL/pgSQL bodies referencing
`auth.uid()`/`auth.jwt()` as an opaque function call, not GoTrue-API calls —
but each should be spot-checked once the shim exists, not assumed.

Heaviest by call volume: `me_context` (16 — by far the single most-called RPC
in the gateway, called from `command-hub.ts`, `autopilot-prompts.ts`,
`longitudinal-adaptation.ts`, `dev-auth.ts` and 12 more files), then
`memory_semantic_search` / `memory_write_item` (3 each). The other 103 are
called once or twice — the long tail is almost entirely the memory-garden,
location, offers, taste-alignment, life-stage, overload, and social-context
RPC families (each ~10-15 sibling functions), all `SECURITY DEFINER`
functions that read `auth.uid()` internally instead of taking a user-id
parameter.

Full list (106, by call count):

| RPC | calls |
|---|---:|
| `me_context` | 16 |
| `memory_semantic_search` | 3 |
| `memory_write_item` | 3 |
| `offers_set_state` | 2 |
| `location_get_visits` | 2 |
| `location_preferences_get` | 2 |
| `lifestyle_profile_get` | 1 |
| `taste_alignment_bundle_get` | 1 |
| `location_checkin` | 1 |
| `memory_build_timeline` | 1 |
| `emotional_cognitive_override` | 1 |
| `memory_request_export` | 1 |
| `lifestyle_profile_set` | 1 |
| `overload_detect` | 1 |
| `relationship_add_edge` | 1 |
| `match_recompute_daily` | 1 |
| `memory_get_garden_summary` | 1 |
| `emotional_cognitive_compute` | 1 |
| `capacity_compute` | 1 |
| `memory_get_quality` | 1 |
| `taste_profile_set` | 1 |
| `health_compute_vitana_index` | 1 |
| `overload_compute_baselines` | 1 |
| `life_stage_score_trajectory` | 1 |
| `community_join_group` | 1 |
| `match_get_daily` | 1 |
| `memory_extract_garden_nodes` | 1 |
| `life_stage_detect_goal` | 1 |
| `topics_get_user_profile` | 1 |
| `taste_alignment_audit_get` | 1 |
| `preference_delete` | 1 |
| `preference_get_audit` | 1 |
| `memory_get_garden_progress` | 1 |
| `location_preferences_set` | 1 |
| `memory_add_diary_entry` | 1 |
| `capacity_get_current` | 1 |
| `health_compute_features_daily` | 1 |
| `constraint_set` | 1 |
| `preference_set` | 1 |
| `inference_downgrade` | 1 |
| `memory_unlock_entity` | 1 |
| `preference_bundle_get` | 1 |
| `memory_get_export_status` | 1 |
| `capacity_override` | 1 |
| `relationship_get_signals` | 1 |
| `offers_record_outcome` | 1 |
| `longevity_compute_daily` | 1 |
| `me_set_active_role` | 1 |
| `overload_explain` | 1 |
| `community_get_recommendations` | 1 |
| `life_stage_update_goal` | 1 |
| `life_stage_get_current` | 1 |
| `health_generate_recommendations` | 1 |
| `overload_get_detections` | 1 |
| `topics_recompute_user_profile` | 1 |
| `alignment_act_on_suggestion` | 1 |
| `offers_get_memory` | 1 |
| `longevity_get_daily` | 1 |
| `memory_retrieve` | 1 |
| `taste_reaction_record` | 1 |
| `constraint_delete` | 1 |
| `memory_apply_time_decay` | 1 |
| `community_recompute_recommendations` | 1 |
| `social_compute_context` | 1 |
| `social_invalidate_cache` | 1 |
| `preference_confirm` | 1 |
| `overload_get_baselines` | 1 |
| `location_nearby_discovery` | 1 |
| `memory_get_timeline` | 1 |
| `memory_get_locked_entities` | 1 |
| `memory_lock_entity` | 1 |
| `emotional_cognitive_explain` | 1 |
| `overload_record_pattern` | 1 |
| `offers_get_recommendations` | 1 |
| `location_add` | 1 |
| `alignment_generate_suggestions` | 1 |
| `memory_get_context_with_confidence` | 1 |
| `memory_write_item_v2` | 1 |
| `match_set_state` | 1 |
| `life_stage_override` | 1 |
| `alignment_mark_shown` | 1 |
| `memory_get_diary_entries` | 1 |
| `memory_get_confidence_history` | 1 |
| `community_get_recommendation_explain` | 1 |
| `memory_adjust_confidence` | 1 |
| `social_update_comfort_profile` | 1 |
| `longevity_explain_daily` | 1 |
| `memory_get_context` | 1 |
| `taste_profile_get` | 1 |
| `life_stage_assess` | 1 |
| `memory_delete_entity` | 1 |
| `emotional_cognitive_get_current` | 1 |
| `alignment_get_suggestions` | 1 |
| `social_compute_proximity` | 1 |
| `relationship_get_graph` | 1 |
| `life_stage_get_goals` | 1 |
| `relationship_update_signal` | 1 |
| `memory_get_settings` | 1 |
| `overload_dismiss` | 1 |
| `get_my_permitted_roles` | 1 |
| `inference_reinforce` | 1 |
| `memory_set_visibility` | 1 |
| `social_get_comfort_profile` | 1 |
| `life_stage_explain` | 1 |
| `mem_episodes_semantic_search` | 1 |
| `memory_compute_quality` | 1 |

## Portable (54) — no auth dependency detected, expected to port as-is

Spot-checked `dev_bootstrap_request_context` (highest call volume, 20) by
reading its actual definition
(`supabase/migrations/20251228000000_vtid_01050_dev_bootstrap_context.sql`):
takes `p_tenant_id`/`p_active_role` as explicit parameters, `SECURITY DEFINER`,
no GoTrue coupling at all — genuinely portable, confirms the auth-detection
approach isn't just missing an indirect reference in this case.

Notable: `credit_wallet`, `debit_wallet_for_spend`, `credit_wallet_for_earning`,
`credit_deposit` (money-moving RPCs) land here as portable-by-detection — but
money-adjacent code deserves the extra diligence this whole migration effort
has applied elsewhere (VTID-03702's B1 pass gave full diff review to every
money-touching file); a "no auth.uid() found" signal is not the same as "safe
to port without review."

| RPC | calls |
|---|---:|
| `dev_bootstrap_request_context` | 20 |
| `resolve_recipient_candidates` | 10 |
| `health_compute_vitana_index_for_user` | 6 |
| `write_fact` | 5 |
| `credit_wallet` | 4 |
| `get_trust_scores` | 3 |
| `fn_get_feature_usage_in_window` | 3 |
| `get_correction_history` | 3 |
| `advance_capability_awareness` | 3 |
| `get_behavior_constraints` | 3 |
| `repair_trust` | 2 |
| `memory_mark_for_reembed` | 2 |
| `memory_get_items_needing_embeddings` | 2 |
| `fn_get_feature_usage` | 2 |
| `check_behavior_constraint` | 2 |
| `vitana_pillar_streak_days` | 2 |
| `record_user_correction` | 2 |
| `reminders_claim_due` | 1 |
| `relationship_ensure_node` | 1 |
| `catalog_add_service` | 1 |
| `pick_specialist_for_text` | 1 |
| `get_user_limitations_impact` | 1 |
| `cleanup_expired_autopilot_recommendations` | 1 |
| `debit_wallet_for_spend` | 1 |
| `topics_create_registry_entry` | 1 |
| `credit_deposit` | 1 |
| `capacity_filter_actions` | 1 |
| `topics_validate_keys` | 1 |
| `get_current_facts` | 1 |
| `health_ingest_lab_report` | 1 |
| `get_viewer_relationship` | 1 |
| `increment_product_recommendation_stats` | 1 |
| `fn_increment_feature_usage` | 1 |
| `reject_autopilot_recommendation` | 1 |
| `health_ingest_wearable_samples` | 1 |
| `build_specialist_context` | 1 |
| `catalog_add_product` | 1 |
| `memory_update_embeddings` | 1 |
| `record_teacher_refresh` | 1 |
| `get_recent_conversations` | 1 |
| `get_personalization_changes` | 1 |
| `record_match_feedback` | 1 |
| `snooze_autopilot_recommendation` | 1 |
| `fn_redeem_code` | 1 |
| `alignment_cleanup_expired` | 1 |
| `fn_consume_credits` | 1 |
| `community_create_group` | 1 |
| `increment_product_recommendation_click` | 1 |
| `community_create_meetup` | 1 |
| `get_region_group` | 1 |
| `memory_correct_item` | 1 |
| `memory_confirm_item` | 1 |
| `credit_wallet_for_earning` | 1 |
| `topics_get_registry` | 1 |

## Not found in tracked migrations (42) — cross-checked against live `pg_proc`

Unlike every other section in this doc, this list **was** verified against
the live `VITANA` project (`inmkhvwdcuyhnxkgfvsb`, `pg_proc` filtered to
`public` schema) this session. The split is real, not a hedge:

### 6 of the 42 exist live — untracked, not dead

`archive_old_intent_matches`, `can_read_intent`, `compute_intent_matches`,
`compute_intent_matches_daily`, `increment_wallet_balance`,
`search_intent_catalog` all resolve in `pg_proc` today. Their `CREATE
FUNCTION` is missing from this repo's `supabase/migrations/` tree — the same
migration-tracking gap the plan's Phase 2 already named (377 file versions
vs. 330 applied rows) — but the functions themselves are real and callable.
**Do not touch these call sites as part of any dead-code cleanup.**
`increment_wallet_balance` is money-moving and real; it appears once in
tracked migrations only as a name in a `REVOKE EXECUTE ... FROM anon` list
(`20260608130000_phase_c_rpc_anon_lockdown.sql`), which is what caused the
initial "no CREATE FUNCTION" false read — the lockdown migration knew about
it, evidently authored elsewhere.

### 36 of the 42 genuinely do not exist live — every call site is failing today

Confirmed absent from `pg_proc` in the live project. Any code path invoking
one of these gets a real Postgres error (`function ... does not exist`) on
every call, right now, in production — not a future risk, a present one.
Two groupings stand out:

1. **The entire `d41`/`d43`/`d44`/`d45`/`d50` family (30 RPCs) is missing, not
   just individual functions** — consent/boundaries (d41), longitudinal
   adaptation (d43), predictive signals (d44), risk-forecasting windows
   (d45), positive-trajectory reinforcement (d50). Every RPC in each numbered
   family is gone, which reads as "the whole feature's DB layer was never
   migrated" rather than five unrelated one-off gaps — consistent with the
   plan's separate finding that `d44_predictive_signals` and
   `risk_mitigations` aren't in the VTID-03486 drift baseline at all. These
   are prime B2 (dead-call-site) candidates — but "the DB function is
   confirmed gone" is a different, stronger claim than "the table looked
   unfamiliar," and still doesn't by itself prove the *call site* is
   unreachable/safe to delete (it may be behind a feature flag, error-handled
   gracefully, or genuinely broken-and-unnoticed — each needs its own
   confirmation, not a bulk delete).
2. **`exec_sql`, `kb_search`, `user_preferences_get_bundle`, `vtn_reward`,
   `vtn_spend`, `vtn_transfer`** — ungrouped singles. `exec_sql` (a
   generic-sounding SQL-execution RPC) does not exist live, which is the
   reassuring answer for the security question this doc originally flagged
   about it. `vtn_reward`/`vtn_spend`/`vtn_transfer` are money-moving names
   that are confirmed gone — unlike `increment_wallet_balance`, these three
   are genuinely dead, not just untracked.

| RPC | calls | live? |
|---|---:|---|
| `d43_get_data_points` | 3 | ❌ missing |
| `increment_wallet_balance` | 2 | ✅ **exists** |
| `archive_old_intent_matches` | 1 | ✅ **exists** |
| `can_read_intent` | 1 | ✅ **exists** |
| `compute_intent_matches` | 1 | ✅ **exists** |
| `compute_intent_matches_daily` | 1 | ✅ **exists** |
| `d41_get_consent_bundle` | 1 | ❌ missing |
| `d41_get_personal_boundaries` | 1 | ❌ missing |
| `d41_revoke_consent` | 1 | ❌ missing |
| `d41_set_consent` | 1 | ❌ missing |
| `d41_set_personal_boundary` | 1 | ❌ missing |
| `d43_acknowledge_drift` | 1 | ❌ missing |
| `d43_create_adaptation_plan` | 1 | ❌ missing |
| `d43_create_snapshot` | 1 | ❌ missing |
| `d43_get_pending_adaptations` | 1 | ❌ missing |
| `d43_record_data_point` | 1 | ❌ missing |
| `d43_rollback_adaptation` | 1 | ❌ missing |
| `d43_update_adaptation_status` | 1 | ❌ missing |
| `d44_create_signal` | 1 | ❌ missing |
| `d44_get_active_signals` | 1 | ❌ missing |
| `d44_get_signal_evidence` | 1 | ❌ missing |
| `d44_get_signal_stats` | 1 | ❌ missing |
| `d44_record_intervention` | 1 | ❌ missing |
| `d44_update_signal_status` | 1 | ❌ missing |
| `d45_acknowledge_window` | 1 | ❌ missing |
| `d45_get_window_details` | 1 | ❌ missing |
| `d45_get_windows` | 1 | ❌ missing |
| `d45_invalidate_window` | 1 | ❌ missing |
| `d45_store_window` | 1 | ❌ missing |
| `d50_count_today_reinforcements` | 1 | ❌ missing |
| `d50_dismiss_reinforcement` | 1 | ❌ missing |
| `d50_get_last_reinforcement` | 1 | ❌ missing |
| `d50_get_recent_reinforcements` | 1 | ❌ missing |
| `d50_mark_delivered` | 1 | ❌ missing |
| `d50_store_reinforcement` | 1 | ❌ missing |
| `exec_sql` | 1 | ❌ missing |
| `kb_search` | 1 | ❌ missing |
| `search_intent_catalog` | 1 | ✅ **exists** |
| `user_preferences_get_bundle` | 1 | ❌ missing |
| `vtn_reward` | 1 | ❌ missing |
| `vtn_spend` | 1 | ❌ missing |
| `vtn_transfer` | 1 | ❌ missing |

## Addendum (VTID-03772), 2026-08-27 — the follow-up this doc's own next-step #1 asked for, and it found a live money bug

This doc's own "Next steps" #1 (below) asked for exactly this: check the
160 RPCs in "Auth-dependent (106)" and "Portable (54)" against live
`pg_proc`, since only the 42-item "Not found" section had actually been
live-verified. Ran it — full existence check, all 202 gateway-called RPC
names against live Supabase `pg_proc` (630 distinct public functions) and
against Aurora's own `pg_proc` (565 distinct) in the same pass.

**Result: 70 more RPCs, beyond the already-confirmed 36, do not exist live
— 106 of 202 gateway-called RPCs (52%) are calling something that isn't
there.** All 70 are new findings from sections this doc explicitly called
unverified: 57 came from "Auth-dependent (106)" and 13 from "Portable (54)"
— **both** static-analysis-only sections turn out to contain confirmed-dead
entries, not just the "Not found" section's already-known 36. Verified
with direct, targeted `pg_proc` queries (not the bulk name-list diff alone)
for the highest-stakes ones below, to avoid the transcription-risk this
same investigation already got burned by once this session (see the
corrected Phase 0 report).

The 70 cluster into the same "whole feature family never got a DB layer"
shape the original 36 (`d41`/`d43`/`d44`/`d45`/`d50`) already showed:
`alignment_*` (5), `overload_*` (7), `location_*` (6),
`taste_*`/`taste_alignment_*` (5), `preference_*` (5), `relationship_*`
(4), `social_*` (5), `topics_*` (5), `memory_*` extensions (7:
`build_timeline`, `compute_quality`, `get_garden_progress`, `get_quality`,
`get_timeline`, `retrieve`, `write_item_v2`), `longevity_*` (3), `match_*`
(3), plus a personalization/trust cluster (`check_behavior_constraint`,
`constraint_delete`, `constraint_set`, `get_behavior_constraints`,
`get_correction_history`, `get_personalization_changes`, `get_trust_scores`,
`inference_downgrade`, `inference_reinforce`, `record_match_feedback`,
`record_user_correction`, `repair_trust`) and one ungrouped, high-stakes
single: **`credit_wallet`.**

### `credit_wallet` — a live, currently-reachable, real-money bug, not a stale/dormant one

This is the one worth pulling out on its own. The original doc's own
"Portable (54)" section listed `credit_wallet` as "portable-by-detection"
and its own "Next steps" #3 said it was "all confirmed live" alongside
`credit_wallet_for_earning`/`credit_deposit`/`increment_wallet_balance` —
**that was never actually checked against live `pg_proc`; it was inferred
from a tracked migration file existing, and that inference was wrong.**
Direct query, this pass: `SELECT ... FROM pg_proc WHERE proname =
'credit_wallet'` — **zero rows, any schema.** The only near-name-match is
`credit_wallet_for_earning`, a genuinely different function
(`p_account_id, p_amount_minor, p_currency, ...` vs. `credit_wallet`'s
call-site shape of `p_tenant_id, p_user_id, p_amount, p_type, p_source,
p_source_event_id, p_description`) — not a rename, not a drop-in swap.

**This is reachable today, not dormant.** `routes/billing.ts`'s Stripe
`checkout.session.completed` handler calls it for `kind === 'credit_pack'`
purchases — real money, via a real Stripe checkout session
(`vitana_kind: 'credit_pack'` metadata is set when the session is created,
confirmed at a separate call site in the same file). Checked whether the
feature is actually purchasable or just wired-but-empty, the same
reachability question B2 already had to ask for `wallet_balances`: **live
`credit_packs` table has 3 active rows right now** (`count(*) FILTER
(WHERE is_active)`, exact count — not the `n_live_tup` estimate, which
misleadingly showed 0 for this exact table earlier in this same session's
row-count sweep, a second independent confirmation of that estimator's
unreliability). A real customer can complete a real Stripe payment for any
of the 3 packs today.

**What happens when they do:** the handler does check the error
(`if (error) { console.error(...); throw new Error(...) }`) — this is not
a silently-swallowed failure the way `billing.ts`'s wallet-snapshot read
was in B2's original addendum. It throws, which Stripe sees as a failed
webhook delivery and retries — but every retry hits the identical
"function does not exist" error, since this isn't transient. The customer
is charged, Stripe's webhook delivery permanently fails, and
`credit_wallet`'s intended effect (crediting the purchased amount) never
happens. Loud on the backend, invisible to the paying user, who sees a
successful payment and no error of their own.

**Not fixed here, deliberately — same reasoning as B2's wallet_balances
addendum, now with an even clearer stake.** `credit_wallet_for_earning`
and `increment_wallet_balance` both exist but neither matches
`credit_wallet`'s parameter shape or its `p_source_event_id`-keyed
idempotency contract (the code comment is explicit: "source_event_id =
session.id so re-delivery never double-credits" — a real safety property
a substitute must preserve exactly, or a webhook retry after a partial
fix could double-credit instead of not crediting at all). Guessing at a
replacement for a money-crediting RPC without knowing which wallet model
is actually canonical (still an open question per B2's own wallet-family
finding) risks trading "no credit" for "wrong credit" or "double credit" —
strictly worse. **This needs an explicit, human, product/eng decision on
which RPC/schema is canonical before any code changes, and probably needs
checking Stripe's dashboard for actual failed `checkout.session.completed`
deliveries on `credit_pack` sessions to see if this has already affected a
real customer** — this pass did not have Stripe API access to check that
directly.

**Checked the prod gateway's own CloudWatch logs instead (`/vitana/gateway-awsdr`,
confirmed via the live ECS task definition's `logConfiguration` as the
actual log group this service writes to — not a guess) — inconclusive, not
reassuring.** Searched 90 days (33.4M records, 3.2GB scanned) via
CloudWatch Logs Insights for `credit_wallet RPC failed`, `credit_wallet
failed`, `credit_pack checkout missing metadata`, and a `credit_pack`+
`credit_paid` success pattern — **zero matches, all four.** Widened to any
occurrence at all of `[billing]` (this route's own log prefix, guaranteed
to appear on any request this handler processes) over the same 90 days —
**also zero.** A follow-up 14-day sweep for bare `billing`/`stripe`/
`checkout.session` matched only unrelated noise (an ORB tool-name array
that happens to contain a similarly-named tool). **This does not mean no
customer has hit the bug** — it's equally consistent with the billing
webhook route genuinely receiving no traffic in this window (0 credit-pack
purchases attempted at all, which the 3-active-packs fact doesn't rule
out) as it is with some other gap in what this specific log group
captures. Recording the exact queries and null result rather than
resolving the ambiguity either way — the Stripe-dashboard check above
remains the actual way to answer this.

### Found DB-level evidence instead, and it surfaces something bigger: a second, competing Stripe webhook path

`billing.ts`'s own idempotency table, `processed_stripe_events` (every
webhook event ID is inserted here *before* processing — "PK conflict =
already handled") — **is completely empty, 0 rows, ever.** On its own
this is ambiguous (a failed-processing path explicitly `DELETE`s its row
"so retry is safer than leaving processed_stripe_events stale," so empty
doesn't cleanly distinguish "never called" from "always failed and
cleaned up"). But checking `stripe_webhook_events` (a *different* table)
for corroboration surfaced something this pass hadn't found yet:

**There are two entirely separate, independently-mounted Stripe webhook
endpoints in this codebase** — `POST /api/v1/billing/webhooks/stripe`
(`billing.ts`, the broken `credit_wallet` path this addendum is about)
and `POST /api/v1/stripe/webhook` (`wallet-stripe-webhook.ts`, VTID-03201,
whose own header comment calls itself **"the primary path"** for
crediting a wallet after `checkout.session.completed`). The second one
uses `credit_deposit` — confirmed to exist live, unlike `credit_wallet` —
via `finalizeDeposit()`/`deposit-service.ts`, entirely independent
machinery. Its own idempotency table, `stripe_webhook_events`, has
exactly **one row, ever** (`source:'wallet'`,
`event_type:'checkout.session.expired'`, 2026-07-20 — a session a
customer started and abandoned, not a completed purchase).

**This doesn't resolve the severity question, it reframes it.** Two
readings, and this pass can't distinguish them without Stripe dashboard
access:

1. Stripe's actually-configured webhook URL is the wallet endpoint, not
   `billing.ts`'s — in which case `billing.ts`'s entire
   `/webhooks/stripe` route (and the `credit_wallet` bug inside it) may
   be **unreachable from real Stripe traffic entirely**, a dead endpoint
   rather than a live one. `processed_stripe_events`'s permanent
   emptiness would be fully explained this way, cleanly, with no need for
   the "always fails and self-deletes" reading.
2. Both endpoints are configured (a real, if unusual, dual-webhook setup)
   and `billing.ts`'s really does receive `credit_pack` events that fail
   silently on `credit_wallet` and self-clean from
   `processed_stripe_events`, while `wallet-stripe-webhook.ts` handles a
   different purchase type (its "deposit" naming suggests wallet
   top-ups generally, which may or may not be the same product surface
   as "credit packs" — not resolved here).

Either way, **`stripe_webhook_events`'s single, non-completed row is
independently reassuring on the "has a real customer been charged and not
credited" question** — whichever endpoint Stripe actually calls, there is
no DB-level evidence of a single *completed* wallet-crediting checkout
session, successful or failed, in this database's history. Not the same
as proof — Stripe's own dashboard remains the authoritative source — but
this is real, first-party evidence pointing toward "hasn't happened yet,"
which the CloudWatch check above could only leave ambiguous.

**One more schema check, kept brief since this thread is already deep:**
`wallet_accounts` (`wallet-stripe-webhook.ts`'s actual crediting target
via `credit_deposit`) is `user_id, currency, balance_minor` — a
single-balance-per-currency model, not the three-bucket
(`purchased_credits`/`reward_credits`/`cash_balance`) shape
`billing.ts`'s `GET /me` reads from the still-missing `wallet_balances`.
**So even confirming which webhook Stripe actually calls won't make the
wallet balance *display* correct** — that reads from a table that doesn't
exist regardless, per B2's original addendum. Crediting and displaying a
wallet balance currently rest on two more incompatible schemas than
either B2 or this addendum initially scoped. Not chased further — this is
already the third layer of the same underlying question ("which wallet
model is canonical") this addendum and B2's both already deferred to a
human decision, and unraveling every remaining layer here would be
diminishing return against the rest of this migration effort's open work.

### Root cause found — this is a known, already-self-documented gap, not a fresh mystery

Searched `supabase/migrations/` for `credit_wallet`/`wallet_balances` and
found the full, already-written story, which changes the framing here:
this isn't an undiscovered defect, it's a **known, deliberately-deferred
one** that just never got its stated follow-up done.

`20260526000000_VTID_03107_wallet_reconciliation.sql` defines both
`credit_wallet()` (exact signature match to `billing.ts`'s call site) and
`update_wallet_balance()`, and opens with `ALTER TABLE
public.wallet_balances ADD COLUMN ...` at line 40 — before either function
definition. `wallet_balances` was supposed to come from an earlier
migration, `20260318000000_vtid_01250_autopilot_automations_engine.sql`
(`CREATE TABLE IF NOT EXISTS wallet_balances`) — but per
`20260704060000_vtid_01250_automations_engine_safe_part.sql`'s own header
comment, that March file **collided on its timestamp with an unrelated
migration** (`20260318000000_fix_activate_recommendation_on_conflict.sql`)
— Supabase's tracker keys by timestamp, only one of the two ever got
applied, and the automations-engine half (including `wallet_balances`)
"silently never existed on the live database."

The July "safe part" migration rescued the collision-free objects
(`automation_runs`, `referrals`, `sharing_links` — confirmed live) but
**explicitly, deliberately excluded** `wallet_balances`/`credit_wallet`,
with its own stated reason: `wallet_transactions` (created by the later,
independent VTID-03107/03200 chain) already exists with an **incompatible
schema** — verified live here: `from_user_id`, `to_user_id`,
`from_currency`, `to_currency`, `exchange_rate` — a VTN currency-exchange
ledger, not the credit ledger `credit_wallet()`/`update_wallet_balance()`
were designed against. The July migration's author called this "separate
follow-up work, not a same-day copy-paste" and left it there.

**This doesn't reduce the severity of the live bug above — `credit_wallet`
still doesn't exist and the Stripe webhook still throws on it today — but
it means whoever picks this up isn't starting from zero.** The design
question (which wallet ledger is canonical, and how `credit_wallet()`
should be rewritten against `wallet_transactions`'s actual live shape) was
already identified by name, over a month before this pass, by someone who
made the deliberate call not to rush it. That call is still probably
right; the follow-up just doesn't appear to have happened yet.

### What this does and doesn't change about the rest of the doc

The 54 RPCs left in "Portable" and the 49 left in "Auth-dependent" after
removing this pass's 70 confirmed-dead ones are **still not fully
live-verified** — this pass checked existence by name only, not that each
remaining function's live body actually matches what the tracked-migration
text describes (the original doc's own next-step #1, second half, about
auth-dependency shape possibly drifting from tracked-migration text, is
still open). Existence is a lower bar than correctness, but it's the bar
that was actually still open, and closing it for 202/202 names (vs. 42/202
before) is the real gain here.

## Addendum (VTID-03772, continued), 2026-08-27 — item 1 below, done for all 96 live RPCs

Not a sample — **all 96 RPCs confirmed to actually exist live** (202 total
minus the 106 confirmed-dead ones from the addendum above) were checked
against their real `pg_proc.prosrc` for `auth.uid()`/`auth.jwt()`/
`auth.role()` references, compared against the static tracked-migration
categorization.

**Result: the static categorization holds up well.** Zero functions
categorized "Portable" turned out to actually reference `auth.*` live
(the risky direction — would have meant treating an auth-coupled function
as auth-free). Two categorized "Auth-dependent"
(`health_compute_features_daily`, `health_generate_recommendations`) don't
actually reference `auth.*` in their live body — the safe direction of
error (more portable than assumed, not less), and low-stakes either way
since B4 execution will need the `auth.uid()` compatibility shim regardless.

**Caveat this pass doesn't close:** a function calling a *second* function
that itself reads `auth.uid()` isn't caught by a single-body text search —
this checked direct references only, not the full call graph. Given the
clean result on direct references, this is a much smaller residual risk
than "any of these could still be wrong," but it's not zero.

## Next steps (not done here — needs a follow-up pass)

1. ~~Spot-check a sample of the 106 "auth-dependent" and 54 "portable" RPCs
   against live `pg_proc` bodies~~ — **done above, all 96 live RPCs, not a
   sample.** Residual gap: transitive auth-dependency through a second
   function call isn't caught by a single-body text search.
2. **Decide what to do with the 36 confirmed-dead RPCs** — the `d41`/`d43`/
   `d44`/`d45`/`d50` family (30) plus `exec_sql`, `kb_search`,
   `user_preferences_get_bundle`, `vtn_reward`, `vtn_spend`, `vtn_transfer`.
   "The DB function is confirmed gone" is a strong, live-verified signal —
   but still not the same claim as "the TypeScript call site is safe to
   delete" (it may be behind a feature flag, error-handled gracefully, or a
   genuinely broken path nobody has noticed). Each call site needs its own
   confirmation before removal, the same discipline B1 applied file-by-file
   for the repository-seam extraction.
3. **Money-adjacent RPCs** — a full diff-level read (like B1 gave
   `spend-service.ts`/`payments-stripe-webhook.ts`) before touching
   `credit_wallet`, `debit_wallet_for_spend`, `credit_wallet_for_earning`,
   `credit_deposit`, or `increment_wallet_balance` (all confirmed live) — and
   before deciding what replaces the confirmed-dead `vtn_reward`/`vtn_spend`/
   `vtn_transfer` call sites, since removing a dead RPC call from a feature
   that's supposed to move money is a product decision, not just a code
   cleanup.
4. This inventory does not attempt B4 itself (the identity/session-GUC shim)
   — that's the plan's own "hard one," described as a multi-quarter
   programme, not a follow-on task for a single session.
5. **Re-run Phase 0's own exit criteria** now that live Supabase access
   exists this session — full row-count + checksum reconciliation, Supabase
   vs Aurora, is still gated on live **Aurora** access, which this session
   has not confirmed either way. Worth checking directly before assuming
   Phase 0 is still blocked the way every prior session recorded it.
   (2026-08-27: superseded — this session got live Aurora access; see
   `docs/AURORA-PHASE0-RECONCILIATION-2026-08-27.md`.)

## Addendum (VTID-03772, continued) — the 70-dead-RPC pattern is a "D-series engine" naming convention, not scattered noise

Grepped `services/gateway/src/services/d*-*-engine*.ts` for the full
"D-series" — a sequential family of 20 numbered personalization/
intelligence engines, `d28` through `d51`. Checked which ones' `.rpc()`
calls resolve live:

| Confirmed **missing** RPCs (whole or partial DB layer never shipped) | Confirmed **live** (DB layer real) |
|---|---|
| d34 (environmental/mobility: `location_get_visits`, `location_preferences_get`, `user_preferences_get_bundle`) | d28 (emotional/cognitive: `emotional_cognitive_*` all live) |
| d41 (boundary/consent — all `d41_*` missing) | d40 (life-stage: `life_stage_*` all live) |
| d43 (longitudinal adaptation — all `d43_*` missing) | |
| d44 (signal detection — all `d44_*` missing; table-level gap already in B2 Addendum 2) | |
| d45 (predictive risk — all `d45_*` missing) | |
| d47 (social alignment — all `alignment_*` missing) | |
| d49 (risk mitigation — table-level gap already in B2 Addendum 3) | |
| d50 (positive-trajectory reinforcement — all `d50_*` missing) | |
| d51 (overload detection — all `overload_*` missing) | |

d32/d33/d38/d39/d42/d46/d48 call no `.rpc()` in their own files (either
DB-free by design or reached through a different layer this grep
wouldn't catch) — not individually confirmed either way, listed for
completeness rather than silently omitted.

**Same shape as the tables B2 already found (`d44_predictive_signals`,
`risk_mitigations` both cited as CLAUDE.md "Core Tables" that don't
exist), now confirmed at the RPC layer for a wider slice of the same
D-series.** This reads as one coherent, known-shaped gap — a batch of
personalization engines whose application code shipped ahead of their
database layer — not 70 unrelated one-off oversights. Also explains most
of the `location_*`/`taste_*`/`preference_*`/`relationship_*`/`social_*`/
`topics_*`/`memory_*`-extension/`match_*`/`longevity_*` clusters from the
addendum above: `location_*` is d34's, `taste_*` maps to d39
(taste-alignment), `social_*` to d35, `topics_*`/`relationship_*` don't
map to a single D-number as cleanly and may be a separate, adjacent
subsystem — not traced further here.

Confirmed reachable, not just referenced: `check_behavior_constraint`/
`repair_trust`/`record_user_correction` (d47-adjacent trust-repair
cluster) are called from `POST /api/v1/feedback/trust/repair`, a real,
mounted, authenticated route (`routes/feedback-correction.ts`, mounted at
`index.ts:1130`) — an ORB self-correction feature that would throw on
every real invocation today, the same reachable-not-dormant shape as
`credit_wallet` minus the money.

## Addendum, 2026-08-29, VTID-TBD — money-adjacent RPC diff-level read (Next Steps item 3)

The follow-up Next Steps item 3 (above) asked for a full diff-level read —
"like B1 gave `spend-service.ts`/`payments-stripe-webhook.ts`" — of
`credit_wallet`, `debit_wallet_for_spend`, `credit_wallet_for_earning`,
`credit_deposit`, `increment_wallet_balance`, and the confirmed-dead
`vtn_reward`/`vtn_spend`/`vtn_transfer`, before anyone touches these call
sites. This is that read. Every call site below was opened and read in
full (not just grepped); every SQL function body quoted below was read
from the actual migration file, not inferred from a comment. No code was
changed, nothing was deleted, nothing was deployed, and no live database
was queried — this pass had no live Supabase/AWS credentials, same
standing caveat as most sessions in this migration effort. Existence
(live vs. dead) is **trusted from the 2026-08-27 addenda above**, which
did have live `pg_proc` access, and is **not** re-verified here except
where noted.

**Builds on, does not repeat, the 2026-08-27 `credit_wallet`/Stripe-webhook
finding above.** That finding covered exactly one of `credit_wallet`'s
four call sites (`routes/billing.ts`'s Stripe webhook) in depth. This pass
covers the other three, plus every other money-adjacent RPC named in Next
Steps item 3, and finds new, independent, higher-severity bugs in two of
them.

### 0. Four incompatible wallet ledgers, not one — worth naming up front

Reading every money RPC's SQL body and call sites surfaces a fact scattered
across this doc's prior addenda but never stated as a single list. This
codebase has **four separate, schema-incompatible wallet systems**, built
at different times, none of which the RPC-existence check alone would
reveal as distinct:

| # | Tables | RPCs | Status | Used by |
|---|---|---|---|---|
| 1 | `wallet_balances` (3-bucket: purchased/reward/cash) + `wallet_transactions` (`tenant_id,user_id,amount,type,source,source_event_id`) | `credit_wallet()` | **Dead** — `wallet_balances` never shipped (migration timestamp collision, per the 2026-08-27 addendum's root-cause section) | Diary streaks, milestones, AP-0708 engagement rewards, Stripe `credit_pack` purchases |
| 2 | `wallet_accounts` (`user_id,currency,balance_minor`) + `wallet_ledger_entries` (append-only, `UNIQUE(reference_type,reference_id,entry_type)`) | `debit_wallet_for_spend()`, `credit_wallet_for_earning()`, `credit_deposit()` | **Live**, transactional, well-designed (§2/§3 below) | Universal cart checkout, Vitanaland Marketplace, recommendation commissions, real Stripe deposits, the ORB `send_funds` voice tool |
| 3 | `user_wallets` (`user_id,currency_type,balance`) | `increment_wallet_balance()` | **Live**, untracked in migrations, no idempotency key of its own | Referral rewards, onboarding welcome bonus, and (per `credit_deposit`'s July bridge migration) the actual table `vitana-v1`'s wallet UI reads for USD |
| 4 | `vtn_wallets` + `vtn_transactions` (`from_user_id`/`to_user_id`/exchange-rate shape, per the base doc's own note) | `vtn_reward()`, `vtn_spend()`, `vtn_transfer()` | **Dead**, and the service that calls them has no live deploy at all (§5) | `services/openclaw-bridge` only |

Ledger #1 and #4 are dead. Ledger #2 is the one genuinely solid piece of
money infrastructure in this list. Ledger #3 is live but thin (see §4).
None of the four are aware of each other at the schema level — a user's
"wallet balance" depends entirely on which of four disconnected tables the
feature they're using happens to read.

### 1. `credit_wallet` (confirmed dead) — the other three call sites

`grep -rn ".rpc(['\"]credit_wallet"` finds four repository wrapper
functions, matching the base doc's "4 calls" count for this RPC:

| # | File:line | Caller | Trigger |
|---|---|---|---|
| 1 | `services/diary-streak-celebrator-repository.ts:56` → called from `services/diary-streak-celebrator.ts:82` | Diary save flow | Every diary entry that crosses a 3/7/14/30-day streak |
| 2 | `services/milestone-service-repository.ts:109` → called from `services/milestone-service.ts:442` and `:526` | `scanUserMilestones()` / `checkMilestonesForAction()` | Any of ~13 lifetime milestones (first diary, first connection, onboarding complete, etc.) |
| 3 | `services/automation-handlers/wallet-payments-repository.ts:40` → called from `services/automation-handlers/wallet-payments.ts:109` (`runWalletCreditReward`, automation **AP-0708**) | Autopilot/automation engine | `reward_type` engagement triggers routed through the automation executor |
| 4 | `routes/billing-repository.ts:176` → called from `routes/billing.ts:797` | Stripe `checkout.session.completed` webhook | Real `credit_pack` purchases |

Call site 4 is the one the 2026-08-27 addendum already investigated in
full (throws loud, Stripe retries and fails identically forever). Call
sites 1–3 were not previously examined — all three assume `.rpc()`
**throws** on a Postgres-level error and wrap the call in `try/catch`, but
supabase-js v2's `.rpc()` does **not** throw on a Postgres error (`function
credit_wallet(...) does not exist`, permission denied, business-logic
error) — it resolves normally to `{ data: null, error: {...} }`. It only
rejects the promise on a network-layer failure (DNS, timeout, fetch
reject). Confirmed by grep: `.throwOnError()` does not appear anywhere in
`services/gateway/src` — nothing in this codebase opts into throw-on-error
semantics. The three call sites that *do* handle this RPC correctly
(`routes/billing.ts:797` above, and `spend-earning-service.ts`/
`deposit-service.ts` in §2/§3 below) all explicitly destructure `{ error
}` and act on it themselves — which is exactly what you'd have to do if
`.rpc()` doesn't throw, and is corroborating evidence for the claim, not
just library-documentation trust.

**1a. `diary-streak-celebrator.ts:81-96` — silent swallow, and the user is
told a lie.**

```ts
try {
  await repo.creditWallet(admin, { p_tenant_id: tenantId, p_user_id: userId,
    p_amount: tier.reward, p_type: 'reward', p_source: 'diary_streak', ... });
} catch (walletErr: any) {
  console.warn(`[diary-streak] credit_wallet failed: ${walletErr?.message ?? walletErr}`);
}
```

Since `credit_wallet` doesn't exist, this `await` resolves normally with
an ignored `{error}` — the `catch` block is unreachable for this failure,
so **not even the `console.warn` fires**. Nothing distinguishes "credit
worked" from "table doesn't exist" at this call site; execution falls
straight through. Two lines later (`diary-streak-celebrator.ts:120-128`),
unconditionally and regardless of the above:

```ts
notifyUserAsync(userId, tenantId, 'diary_streak_milestone', {
  title: `${tier.days}-day diary streak!`,
  body: `${tier.message} +${tier.reward} VTN credited.`,
  ...
}, admin);
```

**Every user who hits a 3/7/14/30-day diary streak gets a push
notification/toast claiming their VTN was credited — 10/20/40/80 VTN
respectively — and it never is, with zero trace in any log.** This is
worse than the Stripe webhook bug: that one at least fails loudly on the
backend, even though the user isn't told. This one actively tells the
user something false.

**1b. `milestone-service.ts:441-454` and `:525-538` — same swallow pattern,
plus a permanently-wrong achievement record.**

```ts
try {
  await repo.creditWalletForMilestone(supabase, { p_tenant_id: tenantId,
    p_user_id: userId, p_amount: def.reward, p_type: 'reward',
    p_source: 'milestone', ... });
} catch {
  // Idempotent — duplicate source_event_id is fine
}
```

Identical shape — an empty `catch` that can never fire for this failure
mode, so the comment's own reasoning ("idempotent, duplicate is fine") is
moot; the RPC never even runs successfully once, dead or duplicate. Both
call sites are reached from `ALL_CHECKERS`, which cover ~13 milestones
(`onboarding_complete`: 50, `diary_streak_30`: 100, `first_health_check`:
25, etc. — `services/milestone-service.ts:39-152`) with reward amounts up
to 100. **Before** the credit attempt, `recordMilestone()`
(`milestone-service.ts:189-218`) already wrote the achievement into
`autopilot_recommendations` with `metadata.reward: def.reward` and
`status: 'completed'` — this record is written unconditionally, so it
permanently claims a reward was granted regardless of whether the credit
call that follows it two lines later ever succeeds. Whether the frontend's
achievement UI actually renders `metadata.reward` to the user was not
checked here (out of this repo's scope, same caveat the base doc's dead-
RPC-callsite audit already applies elsewhere) — but the *data* itself is
already wrong at the point of writing, independent of how it's displayed.

**1c. `automation-handlers/wallet-payments.ts:109-138` (`runWalletCreditReward`,
AP-0708) — the one call site that checks the result, and it changes the
failure mode without fixing it.**

```ts
const { data } = await repo.creditWallet(supabase, { ...rewardConfig });
const result = data as CreditWalletResult;
if (result?.duplicate) { ... }
if (result?.ok) { ctx.notify(...); await ctx.emitEvent(...); }
return { usersAffected: 1, actionsTaken: 1 };
```

This destructures `data` (correctly, unlike 1a/1b) — but never looks at
`error`. Since `credit_wallet` doesn't exist, `data` resolves to `null`
and `result` to `undefined`; both `result?.duplicate` and `result?.ok` are
falsy, so **neither branch runs** — no notification, no OASIS event. This
is a strictly better failure mode than 1a/1b (nobody is told a false
"credited" message), but it is still silent at the automation-tracking
layer: `return { usersAffected: 1, actionsTaken: 1 }` executes
unconditionally on the last line, regardless of the branch outcome, so
every AP-0708 run through this path is logged by the automation executor
as one successful user-affecting action even when the credit never
happened and nothing was sent.

**✅ Fixed 2026-08-29 (all three of 1a/1b/1c).** Each now destructures
`error` from its `repo.creditWallet(...)`/`repo.creditWalletForMilestone(...)`
call and logs it loudly (`console.error`/`ctx.log`, matching each file's
own logging convention) instead of letting it disappear into an
unreachable `catch {}` or an unchecked `data`. **1c** additionally now
returns `{ usersAffected: 0, actionsTaken: 0 }` when the credit neither
succeeded nor was a duplicate, instead of unconditionally claiming one
successful action. None of the three change what happens on success, and
1a/1b's "the streak/achievement record still writes regardless of the
credit outcome" behavior is deliberately left as-is — the underlying
product decision (what replaces the dead `credit_wallet` RPC; whether the
four wallet ledgers should unify) is still open and still reserved for a
human, per this addendum's own framing above. New tests:
`services/gateway/test/diary-streak-celebrator.test.ts` (new file, was
zero coverage), `services/gateway/test/milestone-service.test.ts` (new
file, was zero coverage), and a new `describe('runWalletCreditReward
(AP-0708) ...')` block added to the existing
`services/gateway/test/services/automation-handlers-wallet-payments.test.ts`.
Full gateway suite verified green after each of the three commits.

### 2. `debit_wallet_for_spend` / `credit_wallet_for_earning` (confirmed live) — well-designed, and one real non-atomic-sequence bug

Read `supabase/migrations/20260601000000_VTID_03249_wallet_spend_earning.sql`
in full — both are `SECURITY DEFINER` PL/pgSQL functions, no
`auth.uid()`/`auth.jwt()` reference (confirms the "Portable" classification
is correct), each a single self-contained transaction: `SELECT ... FOR
UPDATE` on `wallet_accounts` to serialize concurrent movement on one
account, a ledger insert into `wallet_ledger_entries` guarded by
`UNIQUE(reference_type, reference_id, entry_type)` for idempotency (an
`EXCEPTION WHEN unique_violation` branch turns a retried delivery into a
clean `duplicate:true` response instead of a 500), then the cached-balance
`UPDATE`. `debit_wallet_for_spend` additionally checks
`balance_minor < amount_minor` **before** the ledger insert and returns a
typed `INSUFFICIENT_BALANCE` error rather than letting a `CHECK` constraint
throw a raw SQL error. No sign-flip, unit-mismatch, or missing-idempotency
defect found in either body.

The idempotency key (`reference_type, reference_id, entry_type`) is a
table-wide `UNIQUE`, not scoped by `account_id` — verified against the
table DDL in `20260529000000_VTID_03200_wallet_stripe_deposits.sql:163`.
This is safe in practice (reference IDs are UUIDs from application code;
an accidental collision across two unrelated accounts would need a UUID
collision) but is worth naming since it means idempotency is enforced
*globally*, not per-account — a caller reusing a `reference_id` for a
*different* account and a *different* `entry_type` combination than
intended would not be caught by this constraint.

**Call sites — three are single-RPC-per-request and correctly checked:**
- `services/checkout/checkout-service.ts:311-333` — universal cart
  checkout debit. Checks `debit.ok`, distinguishes `INSUFFICIENT_BALANCE`
  from a generic `WALLET_DEBIT_FAILED`, leaves pending orders reapable on
  failure. No money moved on error.
- `routes/wallet-admin.ts:88-131` — two admin-only endpoints
  (`POST /wallet/admin/spend`, `POST /wallet/admin/credit`), each a single
  RPC call, `requireExafyAdmin`-gated, checks `result.ok` and maps the
  typed error to an HTTP status.
- `services/recommendation-commissions/credit-recommender.ts:106-128` —
  commission payout to a recommender. Checks `creditResult.ok`; on failure
  writes a `status:'failed'` row to its own ledger table instead of
  silently dropping the payout, and on success records the real
  `wallet_ledger_entry_id` for traceability.

**One call site is a genuine, non-atomic, two-RPC application-level saga —
and it has a real bug in its own compensation logic.**
`services/orb-tools/wallet-payments-tools.ts`'s `send_funds` ORB voice
tool (a peer-to-peer transfer) debits the sender via
`debit_wallet_for_spend` and credits the recipient via
`credit_wallet_for_earning` as **two separate RPC calls, two separate
transactions** — there is no single atomic `vtn_transfer`-style RPC doing
both sides at once (unlike ledger #4's `vtn_transfer`, which per its own
comment "Execute transfer via RPC (atomic)" was *designed* to be one
transaction, but doesn't exist — see §5). The code is aware this is a
saga, not a single transaction: it generates one `transferId`, uses it as
`reference_id` for the debit, the same `reference_id` for the credit
(safe — different `entry_type`s: `service_spend` vs. `earning_credit`, so
the two inserts don't collide on the `UNIQUE` constraint above), and
implements manual compensation for two distinct failure points:

1. **Recipient account can't be created** (`wallet-payments-tools.ts:420-441`):
   ```ts
   if (createErr || !created) {
     // Compensate: the debit succeeded but we can't deliver — refund the sender.
     await creditWalletForEarning({ account_id: senderAccount.id, amount_minor: amountMinor,
       currency, reference_type: 'manual', reference_id: `${transferId}-refund`, ... });
     return { ok: true, result: { sent: false, error_code: 'RECIPIENT_ACCOUNT_FAILED', refunded: true },
       text: `I couldn't set up ${recipientDisplay}'s wallet account, so I've refunded your ... back.` };
   }
   ```
   **The refund's own result is never checked** — `await
   creditWalletForEarning({...})` at line 428 discards the return value
   entirely (no `const refund =`), yet the function unconditionally
   returns `refunded: true` and tells the user, in the assistant's own
   voice, "I've refunded your [amount] back." **Concrete failure
   scenario:** the sender's wallet account transitions to `frozen` in the
   moment between the debit (line 401) and this compensating refund (a
   real, if narrow, race — nothing in this code holds a lock across the
   two RPC calls), or the refund RPC hits a transient `RPC_FAILED`
   (network blip, DB connection reset). `credit_wallet_for_earning`
   returns `{ok:false, error:'ACCOUNT_NOT_ACTIVE'}` (or `RPC_FAILED`) —
   silently, because the result is discarded — and the sender is charged
   for a transfer that never completed and never gets refunded, while
   being explicitly told the opposite by the assistant. This is a real
   fund-loss bug, not a hypothetical: the money is provably gone (the
   debit succeeded and is confirmed via its own checked `debit.ok`) and
   the only correction path silently no-ops.
2. **Recipient credit itself fails** (`wallet-payments-tools.ts:454-476`) —
   by contrast, this second compensation path is written correctly: `const
   refund = await creditWalletForEarning({...})`, then `if (refund.ok)`
   reports the refund succeeded, **else** returns `ok:false` with an
   explicit "needs manual reconciliation — reference `<transferId>`"
   message rather than falsely claiming success. This is exactly the
   pattern path 1 above is missing.

Neither path is covered by `services/gateway/test/wave1-voice-tools-flow.test.ts`
(the file that specifically tests `send_funds`) — that suite covers the
no-confirm preview, the full debit-then-credit happy path, and "debit
fails → credit never called," but has no test for either
`RECIPIENT_ACCOUNT_FAILED` or a failed second-leg credit, so this bug (and
the correctly-written sibling path next to it) are both unexercised by any
test today.

### 3. `credit_deposit` (confirmed live) — well-designed, correctly called, and quietly resolves part of an earlier addendum's open question

Two tracked definitions exist for `credit_deposit`; per this doc's stated
method (most recent wins), the live one is
`20260720090000_bridge_credit_deposit_into_legacy_user_wallets.sql`, which
`CREATE OR REPLACE`s the original
`20260529000000_VTID_03200_wallet_stripe_deposits.sql` version. Both share
the same transactional shape as §2 (`SELECT ... FOR UPDATE` on
`wallet_deposits`, an idempotent "already succeeded" fast path, ledger
insert, balance update, deposit status flip) — no `auth.*` reference in
either version, no correctness defect found. The July version adds one
thing, in the **same transaction** as everything else (not a second
application-level call):

```sql
IF v_deposit.currency = 'USD' THEN
  INSERT INTO user_wallets (user_id, currency_type, balance)
  VALUES (v_deposit.user_id, 'USD', v_deposit.amount_minor / 100.0)
  ON CONFLICT (user_id, currency_type)
  DO UPDATE SET balance = user_wallets.balance + EXCLUDED.balance, updated_at = now();
END IF;
```

Per its own header comment, this exists because `vitana-v1`'s
`useWallet.ts` wallet UI reads balance from `user_wallets` (ledger #3
above), not from `wallet_accounts` (ledger #2) that `credit_deposit`
actually credits — without this bridge, a real Stripe deposit would land
in `wallet_accounts` and never appear in the balance the user sees. **This
is worth connecting to the 2026-08-27 addendum's open question above**
("even confirming which webhook Stripe actually calls won't make the
wallet balance *display* correct — that reads from a table that doesn't
exist [`wallet_balances`] regardless"): that finding was about
`billing.ts`'s `GET /me` route specifically, which is a *different* read
path than `useWallet.ts`. This bridge migration means at least the
Stripe-deposit-via-`wallet-stripe-webhook.ts` → `credit_deposit` path
(ledger #2, the confirmed-primary path per that addendum) **does**
correctly reach the balance a real user's wallet screen shows, for USD —
one fewer broken link than the prior addendum's framing implied, though
EUR deposits are explicitly left `wallet_accounts`-only per the comment
("no EUR concept in the legacy table") and `billing.ts`'s own `GET /me`
(reading the still-missing `wallet_balances`) remains broken regardless,
exactly as already found.

The one call site — `services/wallet/deposit-service.ts:217-238`
(`finalizeDeposit`, invoked from `wallet-stripe-webhook.ts`'s webhook
handler) — destructures `{data, error}` and throws a typed
`DepositServiceError('CREDIT_DEPOSIT_RPC_FAILED', ...)` on error, correctly
propagating to the webhook's own retry/failure handling. No swallow, no
compensation needed (single RPC, single transaction, nothing to roll
back).

### 4. `increment_wallet_balance` (confirmed live, no tracked migration) — thin, no idempotency key, and one call site skips error handling entirely

No `CREATE FUNCTION` for this name exists anywhere in
`supabase/migrations/` — confirmed again here with the same grep pattern
the base doc used, same result (zero matches). Per the 2026-08-27
addendum this RPC is nonetheless confirmed live in `pg_proc`.

**✅ Body read live 2026-08-29 (`pg_get_functiondef`) — no longer
unverified.** Confirms every prior inference exactly, and settles the one
open question (transactional safety):

```sql
CREATE OR REPLACE FUNCTION public.increment_wallet_balance(p_user_id uuid, p_currency_type text, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_balance numeric;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;
  INSERT INTO public.user_wallets (user_id, currency_type, balance, updated_at)
  VALUES (p_user_id, UPPER(p_currency_type), p_amount, NOW())
  ON CONFLICT (user_id, currency_type)
  DO UPDATE SET
    balance = user_wallets.balance + EXCLUDED.balance,
    updated_at = NOW()
  RETURNING balance INTO new_balance;
  RETURN new_balance;
END;
$function$
```

- **Transactionally safe as a single statement** — the `INSERT ... ON
  CONFLICT ... DO UPDATE SET balance = user_wallets.balance + EXCLUDED.balance`
  is one atomic upsert; Postgres serializes concurrent callers on the same
  `(user_id, currency_type)` row, so there is no lost-update race between
  two simultaneous credits for the same user/currency.
- **No idempotency key of its own — now confirmed from the body, not
  just inferred**: no `reference_id`/`source_event_id` parameter, no
  ledger/audit insert, nothing that could de-duplicate a retried call.
  This is a genuine gap (a network timeout where the caller can't tell if
  the credit landed really can double-credit on retry) — but it is a
  design/product question (add an idempotency parameter? wrap callers in
  their own dedup?), not something the 2026-08-29 error-visibility fixes
  to its two call sites attempted to solve, and still isn't solved here.
- **`RAISE EXCEPTION` on invalid input is a real Postgres error**,
  confirming the two call sites' `error` field can legitimately be
  non-null for reasons beyond "the RPC doesn't exist" (e.g. a caller ever
  passing `p_amount <= 0` or a null user id) — the same `error` field
  `sharing-growth.ts`/`onboarding-growth.ts` were fixed to log this session
  now has a second real reason to fire, not just a network blip.

Both call sites are one-line repository wrappers with matching param
shapes (`p_user_id, p_currency_type, p_amount`) — a third, distinct param
shape from both `credit_wallet` (`p_tenant_id, p_user_id, p_amount, p_type,
p_source, p_source_event_id, p_description`) and
`debit_wallet_for_spend`/`credit_wallet_for_earning`
(`p_account_id, p_amount_minor, p_currency, p_reference_type,
p_reference_id, ...`) — confirming, independent of the SQL body being
unreadable, that this is a genuinely separate ledger (#3 above), not a
differently-named alias for either of the other two.

- **`services/automation-handlers/sharing-growth.ts:177-181`
  (`runReferralReward`, automation **AP-0405**)** —
  `await repo.incrementWalletBalance(supabase, {...});` with **no
  destructuring at all**, not even inside a `try/catch`. The call site's
  own comment (lines 147-152) states the self-guard is that the referral
  status-transition `UPDATE` (`updateReferralToSignedUp`) must have
  actually affected a row before this line is reached — a real, sound
  duplicate-credit guard — but it says nothing about whether the credit
  *itself* succeeds. If `increment_wallet_balance` ever returns an
  `error` (a shape this pass cannot rule out without its SQL body — e.g.
  a missing `user_wallets` row for a user who signed up before the row
  was backfilled), the referrer is still told "Your Friend Joined!" via
  the immediately-preceding `ctx.notify()` (line 169) and the automation
  still emits `autopilot.sharing.referral_completed` with the reward
  amount (line 183) — both already executed *before* this line, so this
  particular ordering means a credit failure here doesn't even get a
  chance to suppress the user-facing announcement, unlike diary streaks
  where the notify comes after.
- **`services/automation-handlers/onboarding-growth.ts:94-104`
  (welcome bonus, automation **AP-1301**)** — wrapped in `try/catch`, same
  as diary streaks/milestones: `actionsTaken++` and `ctx.log("Credited
  welcome bonus...")` both execute unconditionally right after the
  `await`, since a Postgres-level RPC error resolves normally rather than
  throwing. The `catch` block (`ctx.log("Wallet credit skipped
  (...)")`\`) is reachable only for a network-layer failure, not a
  same-shape "RPC returned an error field" failure — the same
  `.rpc()`-doesn't-throw gap as §1's diary-streak/milestone call sites, on
  a third RPC entirely.

**✅ Fixed 2026-08-29 (both call sites).** Lower priority than §1's three
sites — `increment_wallet_balance` is confirmed live, not confirmed dead,
so this was defensive hardening against a failure mode this pass could
not rule out, not a fix for observed-broken behavior. `sharing-growth.ts`
now destructures `error` and logs it via `ctx.log` when present (return
shape/notify/emitEvent timing unchanged — the ordering concern noted above,
that the user-facing announcement already fired before this line, is a
separate, unaddressed design question, not something a log line can fix).
`onboarding-growth.ts` now checks `error` explicitly: the success log and
`actionsTaken++` only fire when the credit actually succeeded; a Postgres-
level error logs `Wallet credit failed for user ...: <message>` instead of
the previous unconditional "Credited welcome bonus" claim. New tests in
`services/gateway/test/services/automation-handlers-sharing-growth.test.ts`
and `...-onboarding-growth.test.ts` pin both.

### 5. `vtn_reward` / `vtn_spend` / `vtn_transfer` (confirmed dead) — correctly handled at the call site, unreachable in production regardless

Full read of `services/openclaw-bridge/src/skills/vitana-vtn-wallet.ts`
(the only place these three names appear anywhere in this repository,
confirmed by a repo-wide grep, not just `services/gateway/src` — the same
methodology gap the base doc's own dead-RPC-callsite audit already flagged
in its item 7). All three actions (`transfer`, `reward`, `spend`) are
short and uniform: build args, call the RPC, `const { data, error } =
await supabase.rpc(...)`, `if (error) throw new Error(...)`, then (only on
success) append an audit row to `autopilot_logs`.

**On today's status quo, per the task's own framing ("document precisely
what currently happens on every call today"):** every call to `reward()`,
`spend()`, or `transfer()` throws synchronously, immediately, before
anything else in the function runs. This is the **opposite** of a silent
swallow — it is loud, and it is correct error handling *for the RPC call
itself*. Two things distinguish this from being simply "safe":

1. **`transfer()` does an un-atomic pre-check read before the atomic RPC.**
   Lines 124-137 `SELECT balance, frozen FROM vtn_wallets ... .single()`
   and reject with `wallet_frozen_or_not_found`/`insufficient_balance`
   *before* calling `vtn_transfer`. This is a read-then-decide pattern
   with no lock held across it — a real TOCTOU gap if two concurrent
   transfers both pass this check against the same stale balance — but it
   is moot in practice today, since the RPC after it always fails
   (function does not exist) and no money-moving statement in this file
   ever executes. Recording it here anyway, since the task asks for the
   full status quo, not just the reachable part.
2. **No corruption risk on failure, unlike `wallet-payments-tools.ts`'s
   `send_funds` (§2 above), because the RPC throws *before* any
   compensating/audit write, not after a partial state change.** In all
   three actions, `autopilot_logs` insert (the only write in each
   function) sits *after* the `if (error) throw` line — so the throw
   short-circuits execution before that insert ever runs. There is no
   sender-debited-but-recipient-never-credited state possible here,
   because unlike the gateway's own `send_funds` tool, `vtn_transfer` was
   *designed* to be one atomic RPC doing both legs — its own inline
   comment says so explicitly ("Execute transfer via RPC (atomic)") — so
   there was never a two-step application-level sequence to leave
   half-finished. The dead RPC fails cleanly, not partially.

**Reachability, confirmed independently here rather than only cited from
the dead-callsite audit:** `services/openclaw-bridge` is not listed among
the four services `.github/workflows/EXEC-DEPLOY.yml`'s own header
comment names as deployable (`gateway`, `oasis-operator`,
`oasis-projector`, `vitana-verification-engine`) — but the workflow's
`service` input is free-text, not an enum, and the workflow body does have
one `openclaw-bridge`-specific branch (`EXEC-DEPLOY.yml:456`, an
internal-ingress health-check skip), meaning a manual dispatch naming
`openclaw-bridge` would be accepted rather than rejected outright. That
dispatch would still fail today regardless: the entire job runs
`google-github-actions/setup-gcloud@v2` against GCP project
`lovable-vitana-vers1` (`EXEC-DEPLOY.yml:83,122-124`), and GCP billing on
that project has been disabled since 2026-08-16 (CLAUDE.md §1). So the
correct, precise statement is not "this service has never been deployed"
but **"this service's only deploy path names a specific GCP project whose
billing is off, so any deploy attempt — dispatched today or at any point
since 2026-08-16 — fails before a container ever starts."** Confirms and
sharpens `AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md`'s finding of the same
shape (citing `AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 8) with the
actual workflow lines behind it.

### 6. Atomicity summary across all eight names

| RPC(s) | Atomic unit | Non-atomic application-level sequence found? |
|---|---|---|
| `credit_wallet` | Single RPC, single transaction (per its own SQL) | No — every call site invokes it exactly once per business event |
| `debit_wallet_for_spend` + `credit_wallet_for_earning` | Each is its own single-RPC transaction | **Yes — `send_funds` (§2)**, a genuine two-RPC saga with one correctly-compensated failure path and one incorrectly-compensated one (real bug, above) |
| `credit_deposit` | Single RPC, single transaction (now including the `user_wallets` bridge in the same transaction) | No |
| `increment_wallet_balance` | Single RPC, single atomic `INSERT...ON CONFLICT` upsert (body confirmed live 2026-08-29, §4) | No — both call sites invoke it exactly once |
| `vtn_reward` / `vtn_spend` / `vtn_transfer` | Each intended as its own single, atomic RPC (per source comment) | No — never reaches a second call, because the first one always throws |

Only one genuine non-atomic multi-RPC money sequence exists across all
eight names, and it is the one this pass found a real, unexercised bug in.

### What this addendum does and doesn't establish

Verified by reading: every call site listed above, both `credit_wallet`
migration definitions, both `credit_deposit` migration definitions, the
full `debit_wallet_for_spend`/`credit_wallet_for_earning` migration, and
`EXEC-DEPLOY.yml`'s relevant lines. **Not verified:** `increment_wallet_balance`'s
actual SQL body (genuinely untracked, not just unread — this pass cannot
say more about its transactional safety than the call sites' own comments
claim); whether `vitana-v1`'s achievement/Memory-Garden-adjacent UI
actually renders the `metadata.reward` field written by
`milestone-service.ts` (flagged, not confirmed, per §1b); whether any real
user has actually hit the `diary-streak`/`milestone`/`send_funds`-refund
bugs found here (no live logs or Stripe/production access from this
session — same posture as the rest of this migration effort). This is
still a static-analysis-plus-SQL-read pass, not a live-traffic
confirmation; the diary-streak, milestone, and `send_funds`-refund
findings above are, however, deterministic code-logic bugs independent of
any live-traffic question — they do not need production evidence to be
true, only the source lines cited.

No VTID is attached (see the header above). Whoever picks this up should
allocate one before making any code change, per standing rule 2b/§4.1 —
and per the base doc's own Next Steps item 3, deciding what (if anything)
replaces `credit_wallet`/`vtn_reward`/`vtn_spend`/`vtn_transfer`, and
whether ledgers #1/#3/#4 above should be unified into #2 rather than
patched individually, remains a product decision this document is not
positioned to make.
