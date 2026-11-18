# VTID-05575 - mt-network-r2 / matching-intent-scope-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `matching-intent-scope-db` group of `tasks.md` (tasks 1-4). Sparring record:
`plan-sparring.md`.

Change types: Database, Tooling/docs.
VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md section 7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| 1 `daily_matches.scope` + `tenant_id`, D15 backfill | `supabase/migrations/20261102053000_vtid_05575_daily_matches_scope.sql` |
| 3 health-reason filter (D25), network and community write guard | `supabase/migrations/20261102053100_vtid_05575_daily_matches_guard.sql` |
| 2 intent matchers: pool by scope, default `community` | `supabase/migrations/20261102053200_vtid_05575_intent_matchers_scope.sql` |
| 4 rollbacks | `rollback-053200-intent-matchers-scope.sql`, then `rollback-053100-daily-matches-guard.sql`, then `rollback-053000-daily-matches-scope.sql` |
| 4 read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| 4 pgTAP (59 cases) | `supabase/tests/mt-network-matching-scope.pgtap.sql` + `pgtap/vtid_05575_fixture.sql` |

Apply order: 053000, 053100, 053200 (after VTID-05582's `20261102051000`). Rollback order: 053200, 053100, 053000 (each
refuses when run out of order).

## Acceptance

AC-1 `daily_matches` gains `scope text NOT NULL DEFAULT 'community'` (CHECK community | network) and a nullable `tenant_id`,
with an index and no new unique key.
TEST: pgTAP cases 1-5.

AC-2 Existing rows are classified per D15: a pair sharing a real (non-platform) tenant becomes a community row of it (the
viewer's primary tenant if shared), any other pair a network row.
TEST: pgTAP cases 6-10.

AC-3 No `match_reasons` entry carries a health-derived code (D25): existing rows are cleaned, and a trigger removes
`shared_pillar`, `similar_index` and any code naming the index, a pillar or health on every INSERT and UPDATE; an empty result
becomes `active_member`; only the code decides.
TEST: pgTAP cases 11-21 (19a and 20a are the setup writes).

AC-4 A member can only mark a match (action, viewed_at); user, matched user, score, reasons, scope and tenant are pinned.
TEST: pgTAP cases 22-23.

AC-5 A network row can only point at a member who opted in (`network_visible`) and is not a service bot, notification test
actor or platform-only account, including an account listed after it opted in (rules 43-45); a community row with a tenant
needs a real tenant both members belong to; an unchanged row is not re-checked.
TEST: pgTAP cases 24-35.

AC-6 The helpers are SECURITY DEFINER with a pinned search_path and callable by service_role only.
TEST: pgTAP cases 36-39.

AC-7 The four intent matchers default to the caller's own community; `network` (and the legacy `public`) adds only opted-in
members of other tenants and never a service bot; a tenant-visibility source intent matches inside its tenant; grants, owner and
SECURITY DEFINER are kept; no matcher keeps the old tenant-or-public predicate; match reasons carry no Vitana Index input.
TEST: pgTAP cases 40-54.

AC-8 No bare `current_tenant_id()` policy and no new policy on `daily_matches`.
TEST: pgTAP cases 55-57 and `node scripts/ci/bare-policy-lint.mjs`.

AC-9 Rollbacks restore the previous matchers and drop the objects, refuse out of order, and the three migrations re-apply
cleanly and twice.
TEST: pglite-harness/checks.sh (outputs/checks.txt) and lane.sh --twice (outputs/green-run2-twice.txt).

## Evidence (all in-process PGlite, PostgreSQL wasm, with a pgTAP-compatible shim)

- RED on the `origin/main` state (fixture and the two merged dependencies, no lane migrations): `outputs/red-origin-main.txt`
  (`column "scope" does not exist`). RED with only the first migration: `outputs/red-scope-only.txt`
  (`strip_health_match_reasons` missing).
- GREEN: `outputs/green-run1.txt` (59 ok), `outputs/green-run2-twice.txt` (applied twice, 59 ok).
- Five mutations each turn the file red; restored -> 59 ok: `outputs/mutations.txt`.
- Read-only checks, refused out-of-order rollbacks, rollback, re-apply: `outputs/checks.txt`.
- `node scripts/ci/bare-policy-lint.mjs`: 0 bare policies; jest `mt-identity-bare-policy-lint` 8 pass
  (`outputs/jest-bare-policy-lint.txt`); `validateManifest` ok (`outputs/validate-manifest.txt`).
- The harness loads the REAL VTID-05582 migration and the REAL four matcher bodies of VTID-04888 (pgvector is not available in
  PGlite: `vector(n)` becomes `text` and `<=>` a constant, nothing else; scoring helpers are constant stand-ins because the
  lane changes who is in the pool, not how a candidate scores).
- NOT run here: real pgTAP on a Supabase stack and the full production schema (no docker/psql/supabase CLI). CI is authoritative.

## Decisions taken (most conservative option inside the plan)

- The matcher migration rewrites the live function text with `pg_get_functiondef()` instead of pasting four large bodies: it
  cannot drift from what is live, changes only the pool predicate and the default, and raises (changing nothing) if the
  predicate is not found.
- A legacy explicit `p_visibility = 'public'` (the gateway sends it today) now means the network rule (opted-in members only), not
  everyone. This narrows exposure; the gateway lanes later pass `community` / `network` explicitly.
- `compute_intent_matches(_v2)` take the scope from the source intent's `visibility` (`public` -> network rule, anything else ->
  community). The `user_intents.visibility` column default (`'public'`) is NOT changed here.
- A community `daily_matches` row with no `tenant_id` is still accepted: today's writer sends none, and refusing it would
  break the nightly recompute before `matching-discover-scope-v1` ships.
- The health-reason clean-up of existing rows is not archived (derived values on 24-hour rows that the recompute rewrites); the
  rollback documents this.
- The MIGRATION-QUEUE rows and the drift baseline are not touched: the lane's allowed paths exclude them (lane text: "added by a
  platform-side step") and no table is created. Queue position for the queue owner: after VTID-05582's `20261102051000` and
  `051100` (network-visibility-db); `053000` -> `053100` -> `053200`. The row numbers come after #4832's rows 45-47 (VTID-05576).
- Registering `generate-daily-matches` and the matchers in the lineage-guard inventory is deferred to mt-guardrails-r2 (no
  inventory exists on `main` yet; the lane text names it a stated dependency, not to be duplicated here).
- The `generate-daily-matches` edge function (vitana-v1) still scores on `vitana_index_scores` and writes `shared_pillar` /
  `similar_index`; the trigger strips them until `matching-discover-scope-v1` removes the inputs (D25).
