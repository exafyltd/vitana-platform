---
change_class: standard
---
# mt-schema-queue-followup-r2 — queue rows, schema entries and a test expectation owed by merged mt-network-r2 lanes

<!-- plan:begin -->
## Goal
Owner standing instruction (2026-10-27): "carry it through to the authorized outcome without repeatedly coming back to me
for approval of routine steps." Close platform-side debt the reviewer agent flagged on merged `mt-*-r2` lanes. Docs and one
test only. No migration, no code, no gateway change. Architecture stays modular and focused on the Vitana assistant (owner
learning): each lane touches one file.

## Today (verified on `origin/main` `1327a3d99c`, 2026-11-07)
1. `docs/multitenancy/MIGRATION-QUEUE.md`: last rows are 45-47 (VTID-05576, `20261102050000/050100/050200`) then 51-52
   (VTID-05569). No row exists for VTID-05575 (`supabase/migrations/20261102053000_vtid_05575_daily_matches_scope.sql`,
   `053100_..._daily_matches_guard.sql`, `053200_..._intent_matchers_scope.sql`; merged `5e5aa4859d`). The closing note
   says "Rows 48-50 are reserved for VTID-05575". VTID-05573's migrations (`20261102052000-052300`) are not on `main`
   (PR #4840 is landing); its lane acceptance records the position "after the network-visibility rows (051000/051100),
   before matching-intent-scope-db (053xxx)". Also observed: `main` has the 05582 files (`20261102051000`, `051100`) and
   no queue rows for them (`grep -c 05582` finds only the row-46 dependency text).
2. `DATABASE_SCHEMA.md` has no entry for VTID-05575 or VTID-05573 (`grep -n "05575\|05573"` finds nothing).
3. `DATABASE_SCHEMA.md:1094-1110`: the VTID-05569 section starts at 1094, but line 1110
   "`connections_social` gains `new_follower`; `direct_messages` gains `message_reaction`." belongs to the preceding
   notification-categories entry (its "New member categories" list, ~1085-1092) and sits after the 05569 text, before
   "**Rules:**" at 1112.
4. `supabase/tests/vtid_05150_provision_tenant.test.sql:144` asserts `s.feature_flags = '{"jev":{...}}'::jsonb`. A
   provisioned tenant also receives `feature_flags.erp.bootstrap_requested` once VTID-05506's `20261102141000` lands
   (PR #4839, not on `main` yet), so exact equality would then fail.

## Interfaces between lanes
None. Each lane edits exactly one file; no lane reads another's output. All three are independent and run in parallel.

## Lanes
- `migration-queue-rows` (file: `docs/multitenancy/MIGRATION-QUEUE.md`): (R1-F1, R1-F2 accepted) after row 47 and before
  the VTID-05569 rows, in table order = apply order, add: rows 48-49 for VTID-05582 (`20261102051000`, `051100`; files and
  `docs/validation/VTID-05582/` rollbacks are on `main`); rows 50-53 for VTID-05573 (`20261102052000-052300`, only when
  PR #4840 is on `main`, else skipped and recorded in the lane log); rows 54-56 for VTID-05575 (`053000` -> `053100` ->
  `053200`, rollback order 053200, 053100, 053000, files `docs/validation/VTID-05575/rollback-05*.sql`). The existing
  VTID-05569 rows 51-52 become 57-58 so the sequence stays monotonic in table position; if 05573 is skipped the lane keeps
  05569 at 57-58 and leaves 50-53 reserved with a note. Every textual reference to the old numbers is updated in the same
  edit: the "Rows 48-50 are reserved for VTID-05575" and "Rows 51-52 (VTID-05569)" notes, row 52's "#51" dependency, and
  row 46's "VTID-05582 ... rows" wording (now "rows 48-49"). Dependencies: 05575 rows depend on rows 48 (05582) and 45
  (05576); 05573 rows on rows 45 and 48. Notes bullet per VTID. A grep for `51`/`52` row references proves none is stale.
- `schema-entries` (file: `DATABASE_SCHEMA.md`, items 2 and 3 together because they are the same hot file): move line 1110
  up into the notification-categories entry; add a VTID-05575 section (`daily_matches.scope text NOT NULL DEFAULT 'community'`
  with CHECK community | network, nullable `tenant_id`, `idx_daily_matches_scope_tenant (scope, tenant_id)`, functions
  `is_network_candidate(uuid)`, `strip_health_match_reasons(jsonb)`, `daily_matches_scope_guard()`,
  `intent_pool_allows(uuid,uuid,uuid,text)`, trigger `trg_daily_matches_scope_guard`); add a VTID-05573 section (the
  `bak_*` snapshot tables and the four dropped legacy messenger tables, from `main` if #4840 has merged, else deferred to
  the same follow-up lane). Entries state "not applied by the PR" as the 05569 entry does.
- `provision-test-flags-subset` (file: `supabase/tests/vtid_05150_provision_tenant.test.sql`): replace the equality at line
  144 by two assertions: `s.feature_flags -> 'jev'` equals the same literal, and `s.feature_flags - 'jev' - 'erp'` equals
  `'{}'::jsonb`, so an unknown extra key still fails and the test passes before and after `20261102141000`. Assertion
  message keeps its meaning.

## Deferred
- `docs/validation/VTID-05573/acceptance.md` stale evidence (50 ok / five mutations versus 65 and M1-M13): the file is not
  on `main` (verified), it lives on PR #4840's branch, and its owner is that lane. Deferred to that lane's builder.

## Tests and commands
- `node scripts/collab/preflight.mjs ...` (Collab tests, validate, Lane scope, PR-GATE).
- `provision-test-flags-subset`: the test file runs in the pgTAP/PGlite shim used by CI (`supabase/tests`); the lane
  records red-on-simulated-state evidence (assertion fails when `erp` key present with the old equality) and green with the
  new one.
- Docs lanes: `grep` evidence in `acceptance.md` that each migration file, function and index named exists on `main`.

## Measurement
`docs/validation/<plan VTID>/timings.json` per collaboration.md section 8b.

## Risks
- #4839 or #4840 may land first or last; lanes are written to be correct either way (see above).
- Row numbers may shift at landing, as the queue already warns.

## Unchanged
Migrations, gateway code, CI workflows, `scripts/ci/migration-drift-baseline.json`.
<!-- plan:end -->
