# VTID-04888 — Plan Sparring record

- Change class: standard. Tier: session (plan-sparring skill, partner agent `plan-sparring-partner`, read-only).
- Rounds: 2 + a confirmation pass. Verdict: **CONVERGED**.
  - Round 1: 7 findings — F4, F5 major (F3 raised as minor in the list, called major in the verdict), F1–F3, F6, F7
    minor — all ACCEPTED (F7 already covered).
  - Round 2: F1–F7 closed; 2 new minor (F8, F9) — ACCEPTED; confirmation pass: both closed, no new findings.
- Final plan hash (canonical): `34223a65b8193872212c7634591770246851907bc21dccb59f95cba91696a676`
- Owner approval 2026-10-05 (chat, "yes" to the converged plan). Ordering decision (owner, same day): this fix merges
  before VTID-04883 (ranking gates).
- VTID allocated after approval with `p_plan_hash`; the gate was in `log` mode; sparring recorded in
  `vtid_ledger.metadata.sparring`.

## Round 1 findings (partner, summarised verbatim)
- F1 [minor] "byte-identical to the live definitions" does not say where the captured body is stored or how drift is
  detected. → ACCEPTED: `live-functions-before.sql` + a test that allows only the marked lines.
- F2 [minor] Both allowlist tables already have AFTER INSERT OR DELETE triggers (20261001120000_vtid_04769:376-383).
  → ACCEPTED: distinct names, no ordering dependency.
- F3 [minor/major] EXECUTE on the SECURITY DEFINER helper for `authenticated` lets a client probe which accounts are
  service accounts. → ACCEPTED: service_role only.
- F4 [major] `intent_match_recommendations` rows keyed by the test intents would be orphaned. → ACCEPTED and wider:
  16 rows on test intents, 11 REAL members' rows listing a test intent; 4 FKs reference `intent_matches` (0 child
  rows); the fix-up aborts if any appear.
- F5 [major] A per-row STABLE helper call in the hot-path RPCs. → ACCEPTED: inline NOT EXISTS anti-join.
- F6 [minor] v1 pool-size count. → ACCEPTED: same predicate and early return.
- F7 [minor] DATABASE_SCHEMA.md. → already in the plan.
- Self-found in round 1: `compute_intent_matches_v2` ran for a test account's own intent; the matchmaker profile
  fallback read `profiles` unfiltered. Both added (early returns; gateway filter + `intent_matches` backstop).

## Round 2 findings
- F8 [minor] The backstop must say how it maps `vitana_id_a/b` to the allowlists' user ids. → ACCEPTED: resolve
  `intent_a_id`/`intent_b_id` through `user_intents.requester_user_id` (no vitana_id join), plus `external_target_id`.
- F9 [minor] Name the "new test account with open intents" case in the deferred pool-count note. → ACCEPTED.

## Confirmation pass
"The revised plan is correct … No new findings … CONVERGED."

---

# Plan — Rule 45: test/service accounts never visible to real members (intent matching + member profiles)

Owner approval 2026-10-05: fix the rule-45 breach before the ranking gates (VTID-04883). CLAUDE.md rules 43–45: test,
service and automation accounts must never reach a real member in any form; any surface that lists, searches or
recommends member profiles must exclude `service_bot_accounts` and `notification_test_actors`.

<!-- plan:begin -->
## Change class
standard (DB migration: four RPC bodies, a profile trigger, an intent_matches backstop trigger; one gateway repository
filter; a data fix-up; no route, no auth change).

## Evidence (read-only, production DB 2026-10-05)
- Allowlists hold 3 accounts (`service_bot_accounts` ∪ `notification_test_actors`); all 3 have
  `global_community_profiles.is_visible = true`.
- They own 18 `user_intents` in status `open` (3 `closed`).
- 173 `intent_matches` rows involve one of them (170 test-vs-real, 3 test-vs-test; all `external_target_kind` null);
  latest 2026-07-23. Four FKs reference `intent_matches.match_id`: `intent_events` and `intent_disputes` (ON DELETE
  CASCADE), `user_ratings` and `service_payments` (SET NULL). None of them, nor `match_notifications` or
  `autopilot_prompts`, has a row pointing at those 173 matches (counted).
- `intent_match_recommendations` (matchmaker agent output, one row per intent, `candidates` jsonb): 16 rows belong to
  the test accounts' intents; 11 rows of REAL members' intents list a test-account intent among `candidates`.
- `search_intent_catalog_v2` and `compute_intent_matches_v2` (live `pg_get_functiondef`, matching
  supabase/migrations/20260924090000_vtid_04460_…:35-162) filter only `requester_user_id <> caller` and
  tenant/visibility. `compute_intent_matches_v2` also runs for a test account's OWN intent (src) and pairs it with real
  members. v1 `search_intent_catalog` / `compute_intent_matches` have the same gap; the gateway calls only v2
  (intent-find-match-repository.ts:31, intent-matcher-repository.ts:24); v1 has no caller but is callable.
- Matchmaker profile fallback: `fetchProfilesWithDancePreferences` (matchmaker-agent-repository.ts:44-51) reads
  `profiles` with only `neq(user_id, requester)`; `persistProfileFallbackMatches` (matchmaker-agent.ts:173+) writes the
  picks as `intent_matches` rows (`external_target_kind='profile_match'`). No such rows exist today, but nothing
  excludes test accounts there.
- vitana-v1 reads `global_community_profiles` directly: `useCommunityMembers.ts:53,86` and `useAllNewsFeed.ts:96,194`;
  RLS lets authenticated users read `is_visible = true` rows; the allowlist tables have RLS with no policies, so the
  client cannot filter by them. No trigger on `global_community_profiles` today.
- Both allowlist tables already carry AFTER INSERT OR DELETE triggers `trg_service_bot_refresh_listings` /
  `trg_test_actor_refresh_listings` (20261001120000_vtid_04769:376-383). `intent_matches` has
  `intent_matches_bump_count_ai` (AFTER INSERT) and `intent_matches_set_updated_at_bu`.
- Already compliant (no change): gateway member directory (community-members-repository.ts:106-111),
  `find_community_member` ranker, CA-5 scan, `generate-daily-matches` (VTID-04828); pattern
  `NOT EXISTS (… service_bot_accounts …) AND NOT EXISTS (… notification_test_actors …)` (20260924150000_vtid_04483:120-121).

## Design
1. **Migration** `supabase/migrations/<ts>_vtid_XXXXX_rule45_intents_profiles.sql` (one transaction, idempotent):
   - **RPCs, inlined predicate (no per-row function call):** re-create `search_intent_catalog_v2`,
     `compute_intent_matches_v2` and the two v1 functions from the live definitions with, on the candidate pool AND
     the pool-size count, `AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id =
     ui.requester_user_id) AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors a WHERE a.user_id =
     ui.requester_user_id)`. Both are 3-row tables with a PK on user_id (anti-join, planned once per query).
     `compute_intent_matches_v2` / v1 also `RETURN 0` when the source intent's requester is excluded;
     `search_*` return no rows when `p_user_id` is excluded. Same signatures, volatility, SECURITY DEFINER, search_path,
     grants.
   - **Live capture:** the four live bodies are saved before apply as
     `docs/validation/<VTID>/live-functions-before.sql` (also the rollback); a test diffs each new body against it and
     allows only the added predicate / early-return lines.
   - **Helper** `public.is_excluded_account(uuid) returns boolean` (STABLE, SECURITY DEFINER, search_path pinned) used
     only by the triggers below. EXECUTE revoked from PUBLIC, anon and authenticated (no account-enumeration probe);
     granted to service_role only.
   - **Profile trigger** `trg_gcp_hide_excluded_accounts`: BEFORE INSERT OR UPDATE on `global_community_profiles`, forces
     `is_visible = false` when the row's user is excluded. Owners still read their own row (existing policy).
   - **Allowlist triggers** `trg_service_bot_hide_profile` / `trg_test_actor_hide_profile`: AFTER INSERT on each list,
     set `is_visible = false` on that user's profile. Distinct names from the existing `*_refresh_listings` triggers;
     independent side effects, so order between them does not matter.
   - **Match backstop** `trg_intent_matches_skip_excluded`: BEFORE INSERT on `intent_matches`, returns NULL (row skipped)
     when the requester of `intent_a_id` or of `intent_b_id` (resolved through `user_intents.requester_user_id`, the
     same user_id path the RPCs use — no vitana_id indirection) is excluded, or `external_target_id` (the profile
     fallback's target user) is excluded, each via `is_excluded_account(uuid)`.
     Covers every writer (both RPCs, profile fallback, anything future). Skipped rows do not reach
     `intent_matches_bump_count_ai`.
2. **Gateway**: `fetchProfilesWithDancePreferences` drops excluded users (reads both allowlists with the service client
   and filters, same shape as community-members-repository.ts:106-111). Unit test.
3. **Data fix-up** (`supabase/migrations/data-fixups/<ts>_vtid_XXXXX_rule45_cleanup.sql`), applied with the migration,
   counts logged before/after in the evidence:
   - hide the 3 profiles;
   - close the 18 open intents (`status='closed'`);
   - delete the 16 `intent_match_recommendations` rows of those intents;
   - in the 11 real members' recommendation rows, remove candidate entries whose `intent_id` is a test-account intent
     and null `voice_readback` / `reasoning_summary` (they were written around the old list; the UI falls back to the
     candidate list);
   - delete the 173 `intent_matches` rows (0 dependent rows, verified again inside the fix-up: it aborts if any FK
     child row exists).
4. **No vitana-v1 code change**: both client surfaces read through RLS `is_visible = true`.
5. **DATABASE_SCHEMA.md**: helper, triggers, RPC predicates.

## Deferred
- `countOpenIntentsExcludingUser` (matchmaker pool-size probe) still counts test accounts' open intents; it only picks
  the mode label (solo/early/growth), shows no account. With their intents closed it counts none today; a NEW test
  account listed later with open intents would be counted again (no match can be created — RPC predicates and the
  backstop prevent that). Tracked in the PR as a follow-up, naming that scenario.

## Tests
- SQL harness on a throwaway local Postgres (pattern: scripts/ci/test-vtid-04868-plan-sparring.sh): migration applied
  twice; excluded intents never in `search_*` / `compute_*` results nor pool counts; an excluded source intent computes
  0; real accounts unchanged; excluded profile insert/update stores `is_visible=false`; listing an account hides it;
  an `intent_matches` insert involving an excluded account is skipped, a real one is not; `authenticated` cannot execute
  the helper.
- Jest contract test: migration text (predicate in all four functions incl. pool count, early returns, triggers, grants,
  revoke) and the body-diff against `live-functions-before.sql`; gateway fallback filter.
- Suites: operator, roles, support, full gateway suite.
- Staging verify (read-only): as the staging test user, `global_community_profiles` returns none of the excluded ids
  except its own row; Find-a-Match route stays auth-gated.
- Migration drift gate: applied to the DB before merge (as VTID-04872).

## Rollback
`docs/validation/<VTID>/live-functions-before.sql` restores the four bodies; drop the four triggers and the helper. The
data fix-up is not rolled back (re-showing test accounts would re-break rule 45).
<!-- plan:end -->


## Planner responses — round 1
- F1 ACCEPTED — live bodies captured to `docs/validation/<VTID>/live-functions-before.sql` before apply; a test diffs
  each new body against it and allows only the added lines; the same file is the rollback.
- F2 ACCEPTED — existing `trg_*_refresh_listings` noted; new triggers have distinct names and no ordering dependency.
- F3 ACCEPTED — helper EXECUTE revoked from PUBLIC/anon/authenticated, service_role only; used only by triggers.
- F4 ACCEPTED (and wider than stated) — verified: 16 recommendation rows on test intents (deleted) and 11 REAL members'
  rows listing a test intent as a candidate (candidates stripped, readback/summary nulled). Also: 4 FKs do reference
  `intent_matches` (my "no FK" was wrong) — 0 child rows, and the fix-up aborts if any appear. Match count is 173
  (170 + 3 test-vs-test).
- F5 ACCEPTED — RPCs inline the NOT EXISTS anti-join (the repo pattern); no per-row function call on the hot path.
- F6 ACCEPTED — v1 gets the predicate on pool and count too, plus the early return.
- F7 — no action (already item 5).
- Self-found, added: `compute_intent_matches_v2` ran for a test account's own intent (early return now);
  matchmaker profile fallback reads `profiles` unfiltered (gateway filter + `intent_matches` BEFORE INSERT backstop).

## Planner responses — round 2
- F8 ACCEPTED — the backstop resolves `intent_a_id`/`intent_b_id` through `user_intents.requester_user_id` (user_id
  path, no `app_users`/vitana_id join) plus `external_target_id`, each via `is_excluded_account`.
- F9 ACCEPTED — the deferred note names the "new test account with open intents" scenario.
