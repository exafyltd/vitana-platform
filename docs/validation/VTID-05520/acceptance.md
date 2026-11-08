# VTID-05520 acceptance (mt-guardrails-r2/local-test-stack-pglite)
Change types: Infrastructure/CI, Tooling/docs.

Outcome: the MT-LOCAL-STACK CI job runs the suites on PGlite with no Docker and is green on the lane's PR. A developer runs the same
suites locally with `npm run test:mt-stack`. **Real pgTAP is not used on this stack; the pgTAP-compatible shim
(`scripts/mt/stack/tap-shim.sql`) is the test harness** (plan.md Amendment 2, decision 7).
States: a required table missing after the replay fails the job and names the table, unless `not-replayable.txt` lists it (then SKIP, with
its reason and lanes); a listed table that exists, or a skipped migration that now applies, also fails and names the entry.
Surfaces: n/a: no screen. Callers are the MT-LOCAL-STACK job and a local run.
Locales: n/a. Accessibility: n/a.
Contract: documented in docs/multitenancy/LOCAL-STACK.md (inputs: migrations, replay-skip.json, required-tables.txt, not-replayable.txt,
fixtures; outputs: pass or fail with the failing file or table; loader `file:line`).
Staging proof: not verified on staging: the lane changes no runtime surface and deploys nothing. The covering tests are the lane's node
tests and the MT-LOCAL-STACK run on the PR head.

AC-1 — the stub auth schema holds auth.users, auth.uid(), auth.jwt() and the roles anon, authenticated, service_role, nothing else
  TEST: supabase/tests/local-stack/stack-unit.test.mjs ("stub auth schema")

AC-2 — migrations apply in timestamp order, one in-process database per call; a failing unlisted file is reported by name with its error line
  TEST: supabase/tests/local-stack/stack-unit.test.mjs ("replay", "one in-process database per call")

AC-3 — over the real supabase/migrations tree every migration applies or is a listed skip with reason and error line; no stale skip
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("replay of supabase/migrations on PGlite")

AC-4 — Amendment 3 gate: listed missing table = SKIP, unlisted missing = FAIL, listed but present = FAIL
  TEST: supabase/tests/local-stack/stack-unit.test.mjs ("required-table gate"); supabase/tests/local-stack/repo-gate.test.mjs ("createStack")

AC-5 — the lists: 24 required tables derived from docs/MULTI-TENANT-PLAN.md section 2, every not-replayable entry has reason and lanes
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("the lists")

AC-6 — fixtures: tenants T_A/T_B, a_member, a_admin, b_member, b_admin, ab_dual in the stub auth.users, CANARY_A_<uuid> markers in T_A rows, idempotent
  TEST: supabase/tests/local-stack/fixtures.test.mjs; supabase/tests/local-stack/stack-unit.test.mjs ("fixtures")

AC-7 — the shim runs TAP files and fails (exit 1, never PASS) on a failed assertion, a plan mismatch, a SQL error and a claim on a listed table
  TEST: supabase/tests/local-stack/tap-shim.test.mjs

AC-8 — the workflow has no Docker, service container or secret; @electric-sql/pglite is exact in package.json and pnpm-lock.yaml; LOCAL-STACK.md reports every listed table as unverified and says what is not covered
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("docs, workflow and dependency")

## Decisions taken
1. Required tables = the 18 tenant tables of docs/MULTI-TENANT-PLAN.md section 2 (this includes `tenants`) + the 5 health tables + `user_tenants` = 24 (Amendment 3's count). The test derives the 18 from the plan text, so the list cannot drift from it.
2. Replay is one pass in timestamp order, no retry passes (Amendment 2, decision 3 says "in timestamp order"). Every failing file is a listed skip with its error line.
3. PGlite's bundled `uuid-ossp`, `pgcrypto` and `pg_trgm` are loaded so migrations that create those extensions apply. They are not part of the stub auth schema and add nothing to `auth`. pgvector and pg_cron are not bundled; migrations needing them are skips (Amendment 2, consequences).
4. The CI gate replays with `attemptSkipped` (skipped files are run too and must still fail with the recorded error line), so a stale skip fails the job. Local fixtures runs do not execute skipped files.
5. Tests use `node --test` (no jest dependency added); the only new dependency is `@electric-sql/pglite` 0.5.15, exact, as a root devDependency.
6. The shim lives in schema `tap` (not `extensions`) so it cannot collide with a migration; it is added after the replay and is not part of the replayed schema.
7. `node_modules/` is tracked in git in this repository; it was left untouched and no file under it is staged.
8. The stub schema also gives `anon`, `authenticated`, `service_role` ALL on tables, sequences and functions created in `public` (default privileges, as Supabase does), so RLS policies and not missing grants decide a result. Nothing is added to schema `auth`; `service_role` has BYPASSRLS like Supabase's.
9. Fixtures load inside a transaction with `session_replication_role = replica` so the welcome-chat and notification fan-out triggers (VTID-03990, VTID-03506) never act on them.
10. The workflow runs only when the stack itself changes (its scripts, fixtures, tests, doc, `package.json`, lockfile, the workflow), plus `workflow_dispatch`. A migration-only PR does not run it; whether it should is `ci-wiring`'s decision (Amendment 2, decision 6: replaying the whole tree is not a gate). `pnpm install --ignore-scripts` is used, so prisma's postinstall is not run.
11. Smaller than the stub-auth text: `auth.users` carries `id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at` (columns, not objects). `auth.role()` is not defined (10 migrations that call it are skips; test M5 pins it).

## Measured (outputs/stack-report.txt, outputs/green.txt, outputs/mutations.txt)
- Migrations: 730 top-level files; 424 apply, 306 are skips in `replay-skip.json` (each with reason and first error line); 0 unlisted failures; replay takes about 5 s.
- Skip reasons: 188 need a table no replayed migration creates, 62 fail on replay for other reasons, 27 expect a missing column, 12 need pgvector, 10 call `auth.role()`, 5 need the `storage` schema, 2 need pg_cron.
- Required tables: 24; present 11; not replayable (SKIP, unverified) 13 = 5 with no committed creator (access_audit_log, consents, retrieval_traces, role_sessions, user_roles) + 5 whose creator fails on replay (live_rooms, live_highlights, live_room_attendance, event_attendance, community_listings) + 3 needing pgvector (tenant_catalog_overrides, partner_health_test_orders, data_sharing_consents). This is Amendment 3's 24 / 13 (5 / 5 / 3), measured here and not copied.
- Tests: 50 node tests, all green; red on base: 4 of 4 files fail (outputs/red-on-base.txt).
- Mutations: 10 deliberate breaks of the loader, stub, shim, fixtures and lists each fail at least one test (outputs/mutations.txt).
- Not run here: the MT-LOCAL-STACK job (it runs on the PR head) and the Docker path (none exists).
