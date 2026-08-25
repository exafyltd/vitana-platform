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

## Next steps (not done here — needs a follow-up pass)

1. **Spot-check a sample of the 106 "auth-dependent" and 54 "portable" RPCs
   against live `pg_proc` bodies** — this session verified only the 42
   not-found RPCs' existence live, not the other 160's bodies. A function
   redefined outside this repo's tracked migrations could have a different
   auth-dependency shape live than what the tracked-migration text shows;
   and a function calling a *second* function that itself reads `auth.uid()`
   won't be caught by this pass's textual, single-body search either way.
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
