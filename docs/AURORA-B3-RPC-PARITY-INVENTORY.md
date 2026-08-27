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
