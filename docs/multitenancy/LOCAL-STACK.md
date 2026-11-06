# Local test stack (mt-guardrails-r2 / local-test-stack-v2)

A disposable local Postgres for the multi-tenant guardrail lanes (inventories, DB lints, the pgTAP isolation suite,
contract tests). It holds synthetic fixtures only and is thrown away after each run.

## Rules

- **The replay is the only schema source.** The schema is built by replaying the committed
  `supabase/migrations/*.sql` files on the pinned image. There is no production dump, no `pg_dump`, no schema copy
  from any live database.
- **No lane connects to any live system.** No script, fixture or workflow of this stack connects to Supabase, RDS,
  Aurora, the gateway or any other remote database, and none uses a production secret. The only network targets are
  Docker Hub (the pinned images) and the Ubuntu archive (the pinned apt package). The database is the local
  container `mt-local-stack`, reached through `docker exec` (and published on `127.0.0.1:54329` only).
- `auth`, `storage` and `realtime` come pre-installed with the `supabase/postgres` image and are never re-created. A
  migration that tries to re-create them goes on the skip-list with its error.
- Fixtures INSERT into the pre-existing `auth.users`; they never `CREATE TABLE auth.users`.

## Pinned versions

Copied verbatim from `.kiro/specs/mt-guardrails-r2/plan.md` ("Pinned versions"). A bump changes that table first,
then this file and the scripts in one PR.

| What | Exact value |
|---|---|
| Postgres image | `supabase/postgres:17.4.1.074` |
| Image index digest (recorded, checked by `up.sh`) | `sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670` |
| `pg_prove` apt package | `libtap-parser-sourcehandler-pgtap-perl=3.36-2` |
| Runner / host OS | CI `runs-on: ubuntu-24.04` (not `ubuntu-latest`); locally `scripts/mt/stack/` runs `pg_prove` inside an `ubuntu:24.04` container with the same apt pin |

**Security caveat.** `17.4.1.074` is the version production reports, and the same audit flags it
`vulnerable_postgres_version` (`docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:58`, patches outstanding). It is
pinned only for parity of a throwaway local stack that holds no real data and reaches no live endpoint. The digest
guards against a re-push of the tag; it does not cover upstream vulnerabilities. The upgrade path is a change to the
pin table.

**OS review trigger.** The apt version exists only on Ubuntu 24.04 (noble, universe). When GitHub announces the
`ubuntu-24.04` runner deprecation, or `ubuntu-latest` moves past 24.04, re-pin the OS and the apt version together in
the plan's table and here.

pgTAP itself comes with the `supabase/postgres` image (`CREATE EXTENSION IF NOT EXISTS pgtap`); stock `postgres:16`
does not ship it.

## Scripts (`scripts/mt/stack/`)

| Script | What it does |
|---|---|
| `up.sh [--seed]` | Pulls the pinned image, checks that its `RepoDigests` contain the pinned digest, removes any old `mt-local-stack` container, starts a fresh one on `127.0.0.1:54329`, and waits (bounded, `MT_STACK_BOOT_TIMEOUT`, default 180 s) for `pg_isready -h 127.0.0.1 -U postgres` plus a `SELECT 1` via `docker exec`. Exits non-zero on a digest mismatch or a timeout. `--seed` then runs `replay.sh` (strict) and `seed.sh`. |
| `replay.sh [--discover]` | Applies the top-level `supabase/migrations/*.sql` files in filename (timestamp) order, one file per transaction (`psql --single-transaction -v ON_ERROR_STOP=1`), skipping the files on the skip-list. A file containing `CREATE`/`DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `ALTER TYPE … ADD VALUE` or `VACUUM` runs without the wrapping transaction (still `ON_ERROR_STOP=1`), because PostgreSQL refuses those statements inside a transaction block. Afterwards it tries every skipped file once more; one that now applies is a stale skip. Default mode stops at the first failure; `--discover` records every failure, continues, and then retries the failed files in timestamp order, pass after pass, until a pass applies nothing new (at most `MT_REPLAY_MAX_PASSES`, default 5, passes in all); each file keeps the error of its last attempt. Writes `$OUT_DIR/replay-report.json` (`passes`, `applied_after_pass_1`, and per failed file its final `error` and `attempts`) and one log per file and pass in `$OUT_DIR/replay-logs/`. |
| `seed.sh` | Loads `supabase/tests/fixtures/*.sql` in filename order, one transaction per file. Idempotent. A missing required table (`public.tenants`, `public.user_tenants`, `auth.users`) fails the load; an insert into any other table runs only when `to_regclass` finds it. |
| `smoke.sh` | The T0 spike and T5 smoke test, below. |
| `down.sh` | Removes the container and its data. |

Environment: `POSTGRES_PASSWORD` (default `postgres`; a throwaway local value, not a secret), `OUT_DIR` (default
`${TMPDIR:-/tmp}/mt-stack`), `MT_STACK_CONTAINER` (default `mt-local-stack`), `MT_STACK_DB_USER` (default
`postgres`), `MT_STACK_KEEP=1` (smoke leaves the container running).

## Smoke test (`smoke.sh`)

1. `up.sh` (digest verified).
2. `to_regclass('auth.users')` is non-null before the replay.
3. pgTAP spike: prints `SELECT name, default_version FROM pg_available_extensions WHERE name='pgtap'` and the result
   of `CREATE EXTENSION IF NOT EXISTS pgtap` (`$OUT_DIR/pgtap-spike.txt`).
4. `replay.sh --discover`: any failing migration not on the skip-list, or any stale skip, fails the smoke.
5. Every table in `supabase/tests/local-stack/required-tables.txt` exists (`auth.users`, `tenants`, `user_tenants`,
   the 18 tenant tables and the health tables of `docs/MULTI-TENANT-PLAN.md` §2).
6. `seed.sh` twice; the fixture row counts must be identical (idempotency).
7. `pg_prove` from an `ubuntu:24.04` container with `libtap-parser-sourcehandler-pgtap-perl=3.36-2`, sharing the stack
   container's network, over `supabase/tests/local-stack/*.sql` (pgTAP; `00_smoke.sql` checks `auth.users`, the
   fixtures and the `CANARY_A` marker).

Every step runs (except after a failed boot), a summary block is printed and saved to `$OUT_DIR/smoke-summary.txt`,
and the script exits non-zero if any step failed.

## Running it

Locally (needs Docker and `python3`; nothing else):

```bash
bash scripts/mt/stack/smoke.sh                 # full smoke, container removed afterwards
bash scripts/mt/stack/up.sh --seed             # stack up, replayed and seeded, for other lanes
bash scripts/mt/stack/down.sh
```

In CI: `.github/workflows/MT-LOCAL-STACK.yml` runs `smoke.sh` on every pull request that touches these paths
(`runs-on: ubuntu-24.04`, `permissions: contents: read`, no secrets) and uploads `$RUNNER_TEMP/mt-stack` as the
`mt-local-stack` artifact. The spike result (pgtap availability, replay failures, required tables) is read from that
job's log and artifact.

## Fixtures (`supabase/tests/fixtures/`)

`00_tenants_members.sql`: tenants T_A (`0a000000-0000-4000-8000-00000000000a`) and T_B
(`0b000000-0000-4000-8000-00000000000b`); members `a_member`, `a_admin`, `b_member`, `b_admin`, `ab_dual` (in both
tenants) in `auth.users`, `app_users` and `user_tenants`; the marker `CANARY_A_0a000000-0000-4000-8000-00000000ca01` in
T_A rows only (the T_A tenant name, and a `community_groups` row when that table exists). Every INSERT is
`ON CONFLICT DO NOTHING`. The file first checks `public.tenants`, `public.user_tenants` and `auth.users` and raises an
exception naming any that is missing. Inserts into the optional tables (`app_users`, `community_groups`) are guarded
with `to_regclass` and print a NOTICE when the table is absent.

The replay spike and the categorisation of its failures are in `docs/validation/VTID-05469/spike.md`.

## Skip-list format (`supabase/tests/local-stack/replay-skip.json`)

A JSON array (it starts as `[]`). One object per migration that fails on a fresh database:

```json
[
  {
    "file": "20260101000000_example.sql",
    "error": "psql:<stdin>:12: ERROR:  relation \"x\" does not exist",
    "reason": "why it cannot apply on a fresh database and why skipping it is safe"
  }
]
```

- `file`: the migration's file name in `supabase/migrations/` (top level, no directory).
- `error`: the first `ERROR` line from `replay-report.json`.
- `reason`: why it fails on a fresh database and why the stack is still valid without it.

All three fields are required, non-empty strings; `replay.sh` refuses a malformed list. An entry whose file now
applies is a stale skip and fails the smoke: remove it from the list.
