# D11 local stack on PGlite (VTID-05520)

The local stack for the multi-tenant guard rails (plan `mt-guardrails-r2`, Amendments 2 and 3). It runs in-process on
[PGlite](https://pglite.dev) (`@electric-sql/pglite`, exact version in `package.json` and `pnpm-lock.yaml`), one database per
test file. It needs no Docker, no network, no secret and no production dump. **Real pgTAP is not used**: the suites run through
a pgTAP-compatible assertion shim, which is the test harness. This departs from the pgTAP wording of
`docs/MULTI-TENANT-PLAN.md` §4.2 and §4.9 on purpose (Amendment 2, decision 7).

## Run it
```
pnpm install --frozen-lockfile --ignore-scripts
npm run mt-stack:report     # build the stack the way CI does, print PASS/SKIP per required table
npm run test:mt-stack       # the lane's node tests
node scripts/mt/stack/run-tap.mjs supabase/tests/local-stack/smoke.tap.sql   # one pgTAP-style file through the shim
```
CI runs the same through `.github/workflows/MT-LOCAL-STACK.yml` (job "MT local stack (PGlite)"), on changes to the stack.

## Inputs and outputs (the contract)
| Input | File | What it holds |
|---|---|---|
| migrations | `supabase/migrations/*.sql` (top level only) | applied in name (= timestamp) order, one pass, on an empty database |
| skips | `supabase/tests/local-stack/replay-skip.json` | `{ skips: [{ file, reason, error }] }`: migrations that fail on PGlite, each with its reason and first error line |
| required tables | `supabase/tests/local-stack/required-tables.txt` | the 24 tables the guard-rail lanes need |
| not replayable | `supabase/tests/local-stack/not-replayable.txt` | `table \| reason \| lanes`: required tables the replay cannot create |
| fixtures | `supabase/tests/fixtures/*.sql` | synthetic, idempotent, name order |

Outputs: the stack (`createStack()` returns the database and a report) or a `StackGateError` whose message names the
failing migration file or table; `check-stack.mjs` prints `PASS`/`SKIP` per required table and exits 1 on a failure;
`run-tap.mjs` prints TAP and `PASS local-stack <file>` / `FAIL local-stack <file>` and exits 1 on any `not ok`, plan
mismatch or SQL error.

The gate (Amendment 3):
- a required table that exists after the replay: PASS;
- a required table that is missing and listed in `not-replayable.txt`: SKIP, reported as **unverified** with its reason and lanes;
- a listed table that exists (stale listing), a listing of a table that is not required, a missing table that is not listed,
  a migration that fails and is not in `replay-skip.json`, a skip that now applies or names a file that is gone: the gate FAILS and names the file or table.

Loader code: `openDb` (`scripts/mt/stack/stack.mjs:41`), `replay` (`scripts/mt/stack/stack.mjs:85`),
`checkRequiredTables` (`scripts/mt/stack/stack.mjs:115`), `loadFixtures` (`scripts/mt/stack/stack.mjs:143`),
`createStack` (`scripts/mt/stack/stack.mjs:168`), `runTapFile` (`scripts/mt/stack/stack.mjs:205`). The stub auth schema is
`scripts/mt/stack/stub-auth.sql`, the shim `scripts/mt/stack/tap-shim.sql`. `node scripts/mt/stack/discover-skips.mjs --write`
regenerates `replay-skip.json` when a migration is added that PGlite cannot apply.

## What the stub provides
Schema `auth` holds `auth.users`, `auth.uid()`, `auth.jwt()` and nothing else; the roles `anon`, `authenticated`,
`service_role` exist (Amendment 2, decision 4). A test sets the caller with
`SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', false); SET ROLE authenticated;`.
Like Supabase, the three roles get ALL on tables, sequences and functions created in `public`, so RLS policies, not missing grants,
decide a result. PGlite's bundled `uuid-ossp`, `pgcrypto` and `pg_trgm` are loaded.

## Fixtures
Tenants `T_A` and `T_B`; users `a_member`, `a_admin`, `b_member`, `b_admin`, `ab_dual` (in the stub `auth.users`, with
`user_tenants` rows; `ab_dual` is in both tenants); `CANARY_A_<uuid>` markers in T_A rows of `community_groups`,
`community_meetups`, `services_catalog` and `health_features_daily`, and `CANARY_B_<uuid>` rows in T_B. Ids are in
`scripts/mt/stack/fixture-ids.mjs`. Fixtures load with triggers off so the welcome-chat and notification fan-out triggers never fire.

## The shim
`plan`, `ok`, `is`, `isnt`, `matches`, `doesnt_match`, `lives_ok`, `throws_ok`, `is_empty`, `results_eq`, `set_eq`, `diag`,
`finish` and `require_table(name)`. `require_table` **fails** (it never passes) on a table listed in `not-replayable.txt`
and says it is unverified, so an isolation suite cannot go green over a table the stack does not have. Not covered: pgTAP
catalog assertions (`has_table`, `policies_are`, ...), skip/todo, any TAP protocol beyond plain lines.

## What this stack does not cover
Every isolation claim made on it shows the policy on the tables that were loaded, not the production auth path.
It does not cover:
- Supabase Auth itself (JWT issuing, sessions, the access-token hook, `auth.role()`), Realtime, Storage (5 migrations that need the storage schema are skipped), pg_cron, or pgvector (PGlite does not bundle them);
- the migrations in `replay-skip.json`: they are not applied, so their tables, functions and policies are absent from this stack;
- any behaviour of the tables below.

## Unverified tables (not replayable on PGlite, Amendment 3)
Any claim that touches one of these is **unverified** here. The isolation suite fails on them, it does not pass. To close one: a
committed migration that creates it (an owner decision, the plan calls these tables live), removal from the required list (a plan
change through sparring), or a replay fix inside a lane of this plan.

| Table | Why it is unverified | Lanes that need it |
|---|---|---|
| `access_audit_log` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `consents` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `retrieval_traces` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `role_sessions` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `user_roles` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `live_rooms` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` fails on a fresh replay (column "source_type" does not exist) | isolation-suite, generated-inventories |
| `live_highlights` | same migration | isolation-suite, generated-inventories |
| `live_room_attendance` | same migration | isolation-suite, generated-inventories |
| `event_attendance` | same migration | isolation-suite, generated-inventories |
| `community_listings` | `20260727090000_bootstrap_community_marketplace.sql` fails on a fresh replay (column "tenant_id" referenced in foreign key constraint does not exist) | isolation-suite, generated-inventories |
| `tenant_catalog_overrides` | `20260416120000_vtid_02000_marketplace_foundation.sql` needs pgvector | isolation-suite, generated-inventories |
| `partner_health_test_orders` | `20260914090000_vtid_03885_partner_health_test_integration.sql` needs `public.product_orders` from the pgvector-dependent marketplace foundation | isolation-suite, generated-inventories |
| `data_sharing_consents` | same migration | isolation-suite, generated-inventories |

A test (`supabase/tests/local-stack/repo-gate.test.mjs`) fails when this table and `not-replayable.txt` disagree.
