# VTID-05023: Rehearsal failure classification

Status: PARTIAL. This list is INCOMPLETE. Only two failures were provided to this agent. The full classification waits for the full rehearsal pass (731 migrations, in order, continue-past-errors mode) to finish. The full apply log (`/root/vtid05023/apply-full2.log` on the rehearsal side) was not available here.

Scope: classify known failures and propose compat-layer additions. No migration was edited. The B compat layer was not changed.

## Error classes

- MIGRATION BUG: the SQL itself is wrong for the target schema.
- ENVIRONMENT: the failure came from the rehearsal runner, network, or session state. The migration is fine.
- ORDER: the file ran before an object it needs existed.
- MISSING OBJECT: the file needs an object that no migration or compat layer creates.
- ALREADY EXISTS UNVERIFIED: the apply reported "already exists". This does not count as applied (see the rule below).

## Known failures

| # | File | Error class | Object it should have created | Action |
|---|------|-------------|-------------------------------|--------|
| 1 | `supabase/migrations/20251120000001_add_migration_governance_rules.sql` | MIGRATION BUG (provisional, see note 1) | Row `governance_categories` (tenant `SYSTEM`, name `MIGRATION_GOVERNANCE`). Seven rows in `governance_rules`, rule codes MG-001 to MG-007. | Fix in a new migration. Owned by another agent; not fixed here. Compare the rehearsal table definition first (note 1). |
| 2 | `supabase/migrations/20260214000000_oasis_actor_surface_tracking.sql` | ENVIRONMENT | Columns `oasis_events.actor_id`, `actor_email`, `actor_role`, `surface`, `conversation_turn_id` (all `text`). Six indexes `idx_oasis_events_*`. Column comments. | Rerun. Do not change the file. The error was a proxy connection failure on the sandbox side. |
| 3 | Not named. Early files whose transaction was cut when the stale rehearsal session was closed. | ENVIRONMENT (caused by the rehearsal operator closing a session) | Unknown until the file list is provided. | Rerun. Pending the full log. |

Note 1, on failure 1. The failing statement is the first `INSERT ... ON CONFLICT (tenant_id, name)` into `governance_categories`. On main, `20251120000000_init_governance.sql` creates that table with `UNIQUE(tenant_id, name)`, and no later migration drops it. So the ON CONFLICT target is valid in the source. The failure therefore suggests the rehearsal table has a different shape. Two causes fit: the table was created before `init_governance` ran (so its `CREATE TABLE IF NOT EXISTS` was an ALREADY EXISTS no-op), or the table was built outside the migration chain. If so, the true class is ALREADY EXISTS UNVERIFIED for the table, and the fix may be in the table, not in this file. Compare `\d governance_categories` on the rehearsal with the definition in `20251120000000_init_governance.sql` before writing the fix.

## Continue-past-errors record

Each skipped file is recorded with the object it should have created. A skipped file is not applied.

| File | Error recorded | Object it should have created | Status |
|------|----------------|-------------------------------|--------|
| `20251120000001_add_migration_governance_rules.sql` | ON CONFLICT target has no matching unique constraint on the rehearsal | MIGRATION_GOVERNANCE category, MG-001 to MG-007 rules | Skipped, not applied |
| `20260214000000_oasis_actor_surface_tracking.sql` | Proxy connection error | Five `oasis_events` columns, six indexes, comments | Skipped, not applied. Rerun. |
| Unnamed (stale-session cut) | Transaction cut | Unknown | Skipped, not applied. Rerun. Pending the full list. |

Parity must report every skipped file as a known difference until its rerun is recorded. Until then, the rehearsal is not a valid parity source.

## Rule: ALREADY EXISTS is not applied

A migration that fails with "already exists" is `exists, unverified`. It is not counted as applied. It counts as applied only after the existing object is compared with the migration's definition (columns and types, constraints, indexes, function body, grants). Until that comparison is recorded, the count of applied migrations excludes it.

## Compat layer check (against the two failures and the B layer)

Source: `docs/validation/VTID-05023/compat-objects.md`. This file exists only on `cutover/vtid-05023-B-compat-layer` (MR !19), not on main. The B layer is `supabase/migrations/20251026235959_aurora_compat_layer.sql` on that branch.

- Failure 1 uses only `governance_categories` and `governance_rules`. It references no `auth.*`, role, or `storage.*` object. The compat doc does not list it.
- Failure 2 uses only `public.oasis_events`. It references no compat object. The compat doc does not list it.
- The B layer covers roles `anon`, `authenticated`, `service_role`, schema `auth`, and `auth.jwt()`, `auth.uid()`, `auth.role()`. Neither failure needs any of these.

Result: no object needed by the two failures is missing from the B layer. No addition is proposed from these two failures.

Gaps the full pass may expose. These are known from `compat-objects.md`, not from the failures:

- `auth.users` (76 files, mostly `REFERENCES auth.users(id)`). The B layer excludes it on purpose. A view cannot be an FK target. Owner decision needed. Proposal, for decision only: a real stub table in the compat layer, which would need a separate owner sign-off.
- `auth.sessions`, `auth.oauth_clients`, `auth.oauth_authorizations` (2 to 3 files, MCP OAuth and partner terms). Not created by the B layer. Owner decision on whether those files are Aurora-only or skipped.
- `storage.objects`, `storage.foldername`, `storage.buckets` (5 files). Storage stays on Supabase, so these files are skipped on Aurora, not added to the layer.

## Next steps

1. Rerun failure 2 and every unnamed file from the stale-session cut.
2. Compare the rehearsal `governance_categories` with `20251120000000_init_governance.sql`, then fix failure 1 in a new migration.
3. Record the full list of failures and skips when the pass finishes. Replace the "Known failures" table with it.
4. Make the auth.users and storage decisions before the parity run.
