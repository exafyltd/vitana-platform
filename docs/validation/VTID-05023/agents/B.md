# VTID-05023 agent B: Aurora compatibility layer

Branch: `cutover/vtid-05023-B-compat-layer` (from origin/main a02b8918f3). Code commit: `7cc53b2ccb`.
Nothing was run against production, the rehearsal clone, Aurora, or the staging Supabase project.

## Result

Done, with two open decisions for the owner (see "Blockers"). The compatibility layer applies, and the RLS proof passes. Applying the full migration set on PGlite still fails 437 of 733 files, because PGlite lacks production base tables that no migration in the repo creates. The same run with the layer removed fails 647 files, so the layer removes 210 failures.

## 1. Object inventory

Ran `node scripts/aws/aurora-compat-lint.mjs --all` over the 733 files in `supabase/migrations`. The script lives on `cutover/vtid-05023-lane` and was not on main, so I brought it onto this branch with its test and fixtures.

Output:

```
checked 733 file(s); flagged 369; clean 364
```

Per-object counts are in `docs/validation/VTID-05023/compat-objects.md`. Summary (matches / distinct files):

| Object | Matches | Files | In compat layer |
|---|---:|---:|---|
| role `authenticated` | 1109 | 169 | yes |
| role `service_role` | 575 | 208 | yes |
| role `anon` | 16 | 10 | yes |
| `auth.uid` | 950 | 184 | yes |
| `auth.role` | 40 | 19 | yes |
| `auth.jwt` | 38 | 12 | yes |
| `auth.users` | 163 | 76 | no (see Blockers) |
| `auth.sessions`, `auth.oauth_clients`, `auth.oauth_authorizations` | 6 | 4 | no |
| `storage.objects`, `storage.foldername`, `storage.buckets` | 68 | 5 (objects, foldername), 2 (buckets) | no (Storage stays on Supabase) |

The `auth.md` match is a file path inside a seed migration's string text, not an object reference. The extension rule has 0 matches. The held drop `20261102052300_vtid_05573_legacy_messages_drop.sql` is not flagged and was not touched.

## 2. Migration file and apply order

File: `supabase/migrations/20251026235959_aurora_compat_layer.sql`.

I did not use the requested name `20261112000000_...`. The runner applies files in name order, so that name would sort after every existing migration and run last. The earliest existing file is `20251027_oasis_events_v1.sql`. The new name is that version minus one second. It sorts first, and the apply order requires it.

Contents, each statement idempotent:
- `CREATE SCHEMA IF NOT EXISTS auth`.
- A DO block that creates `anon`, `authenticated` and `service_role` as NOLOGIN, only when `pg_roles` lacks them. `service_role` is not BYPASSRLS. Supabase's role has that attribute, so Aurora's PostgREST setup must grant it separately if the service role must bypass RLS.
- `GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role`. Without it, a policy calling `auth.uid()` fails with a permission error.
- `auth.jwt()` returns `nullif(current_setting('request.jwt.claims', true), '')::jsonb`.
- `auth.uid()` returns the `sub` claim as uuid, `auth.role()` returns the `role` claim as text. Both return NULL when the claim is absent.
- Functions use `CREATE OR REPLACE`.

Not created, and why:
- `auth.users`. A view over `auth_user_fk_map` does not fit. That table is `public.auth_user_fk_map` (defined in `scripts/aws/aurora-cutover-auth-bridge.sql`, not in a migration). It holds FK cleanup rules (table, column, on-delete action) and no user rows, so it has no `id` column. Also, views cannot be foreign-key targets, and 76 files use `REFERENCES auth.users(id)`.
- `auth.sessions`, `auth.oauth_clients`, `auth.oauth_authorizations`. These are Supabase Auth internal tables used by 3 files.
- `storage.*`.

The header says Aurora-only, explains that Supabase owns these objects, and names the marker the apply tool reads.

## 3. Apply tooling

- `scripts/ci/apply-sql-via-management-api.sh` (the Supabase path, used by RUN-MIGRATION.yml's supabase job). If the first 30 lines contain `-- AURORA-ONLY:`, it prints a `::notice::` and exits 0 before any token or network check. It does not apply or record the file.
- `scripts/aws/aurora-apply-migration.sh` (the Aurora path). It applies every file as before. For a marked file it prints `AURORA-ONLY file: applied to Aurora (Supabase skips it)`.
- Test: `scripts/aws/test/aurora-only-skip.sh`. It uses a fake `curl` and a dry run, so it needs no network and no database. Fixtures in `scripts/aws/test/fixtures/aurora-only/`:
  - `aurora-only-marked.sql`: marker in the header, passing case, must be skipped on Supabase.
  - `aurora-only-late-marker.sql`: marker on line 31, must not count as a header marker, so it is applied on Supabase.
  - `plain.sql`: no marker, must be applied on Supabase.
  - The Aurora dry run must accept the marked file.

The existing `scripts/aws/test/aurora-apply-migration.sh` needs a PostgreSQL server. None is installed here, so I did not run it. The file's behaviour is unchanged, so the change does not affect it.

## 4. Tests and exact outputs

PGlite: `@electric-sql/pglite` 0.5.16, installed with npm at `/projects/sandbox/.tools/pglite`, the path the existing harness imports. `uuid_ossp` is loaded from the package's contrib module. The PGlite version here is not the PostgreSQL 18 named in the harness README.

Runs (outputs saved under `docs/validation/VTID-05023/outputs/`):

```
$ node --test scripts/aws/test/aurora-compat-lint.test.mjs      -> B-lint-unit.txt
# tests 4
# pass 4
# fail 0
exit 0

$ bash scripts/aws/test/aurora-only-skip.sh                    -> B-aurora-only-skip.txt
ok - marked file is skipped on Supabase without a network call
ok - marker below line 30 does not skip the file on Supabase
ok - plain file is applied on Supabase
ok - marked file is accepted by the Aurora path
# all 4 passed
exit 0
```

Negative control for that test: I disabled the skip (line-count condition changed to `-le 0`). The test printed `# 1 failing` and exited 1. I restored the file, and it again printed `# all 4 passed`.

```
$ node scripts/aws/aurora-compat-lint.mjs supabase/migrations/20251026235959_aurora_compat_layer.sql
... [supabase-role] / [auth-schema] lines 24-51 ...
checked 1 file(s); flagged 1; clean 0
exit 1
```

This is expected: the file defines the Supabase-only objects, so the lint flags it. No CI job runs the lint on PRs, so nothing blocks on it. Output: `B-lint-compat-file.txt`.

RLS proof (`node docs/validation/VTID-05023/pglite/full-set.mjs --rls`, output `B-pglite-rls.txt`). The compat layer is applied, then a table with RLS and `USING (owner = auth.uid())` is tested as role `authenticated`:

```
# applied 20251026235959_aurora_compat_layer.sql
auth.uid() with claim sub=A: 11111111-1111-1111-1111-111111111111
claim=A: rows=[1,3]
ok - claim set to user A returns A rows (want [1,3])
claim=B: rows=[2]
ok - claim set to user B returns B rows (want [2])
auth.uid() with empty claim: null
claim=empty: rows=[]
ok - empty claim returns no rows (want [])
auth.uid() with claim unset: null
claim=unset: rows=[]
ok - claim unset returns no rows (want [])
# RLS probe: PASS (4 ok, 0 not ok)
exit 0
```

Full set in order (`node docs/validation/VTID-05023/pglite/full-set.mjs`, output `B-pglite-full-set.txt`, 737 lines). It applies every file in name order to an empty PGlite database. It skips the held drop, and the compat file goes first.

```
# full set in order: 733 files, pass 296, fail 437
exit 1
```

Control run without the compat layer (`--no-compat`, output `B-pglite-full-set-no-compat.txt`):

```
# full set in order: 733 files, pass 85, fail 647
exit 1
```

Failure causes in the full run (count of files):
- `relation "auth.users" does not exist`: 32. The auth.users gap above.
- `relation "auth.oauth_clients" does not exist`: 1.
- Base tables the repo never creates, so they must come from production: `public.tenants`, `app_users`, `user_tenants`, `profiles`, `products`, `agent_personas`, `calendar_events` and others. Also `function public.current_tenant_id()`, 25 files.
- `type "vector" does not exist`: pgvector is not loaded in this run.
- psql meta-command `\set` (or similar) in 7 files, for example `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql`. The Aurora apply path rejects these by design.

The run continues past each failure. After a failure it rolls back, because PGlite otherwise leaves the session aborted. An earlier run without that rollback produced 714 failures, most of them cascades, and was discarded.

Existing tests: not run beyond the above. No existing test assertion was changed or skipped. The `vtid-05005` test was not touched.

## Blockers and owner decisions

1. `auth.users` (76 files, 32 FK failures in PGlite). Options: (a) create a real `auth.users` table (id uuid primary key, plus the columns migrations read) in the compat layer, which fits FK references but diverges from Supabase's table; (b) leave FK-referencing tables out of Aurora until the owner rewrites them. Owner must choose. I did not create anything.
2. The 7 files with psql meta-commands (`\set`). They fail on the Aurora path and cannot be fixed in place, because existing migrations must not be edited. Owner must choose: a new migration that replaces them, or an apply-tool change to strip meta-commands.
3. Base tables missing from the repo, such as `public.tenants`, need production schema exports, not migrations. A full-set PGlite pass needs those exports loaded before the migrations.

## Not done

- Merge: not done, per instructions. The MR targets main and is left open for the owner.
