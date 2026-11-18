# VTID-05803: fixes from Kiro 4 for Kiro 6's consolidated implementation

This is not a package. Package A (`47047edd…efa4`, commit `dc1355ac`) is unchanged and is superseded by Kiro 6's
consolidated implementation. Kiro 6's commit `a441c48d` and `backup/vtid-05803-native.bundle` were not reachable from
this session (GitLab returns 404 for the commit, and GitHub returns 422), so the review below is a checklist to apply,
not a diff against that code.

`kiro4-fixes.patch` applies cleanly to `dc1355ac` and is tested: `tests/run-local.sh` 85/85 on PostgreSQL 17.12 with
pgvector (`run-local-with-patch.txt`). Port the behaviour, not necessarily the code.

## Fixes found by execution (each one failed a real PostgreSQL 17 run first)
1. **Auth bridge deletion map is empty after a schema-only restore.** `auth_bridge_handle_deleted_user()` raises
   `public.auth_user_fk_map is empty` (`scripts/aws/aurora-cutover-auth-bridge.sql`). The patch loads it in the
   restore transaction from the source catalog with the existing `scripts/aws/supabase-auth-fk-map-export.sql`. This is
   FK metadata, not member data. STEP 9 checks that the row count equals the export.
2. **Role grants on PostgreSQL 16+.** `GRANT anon TO authenticator` needs ADMIN OPTION even if the membership exists.
   Grant only missing memberships, warn on `insufficient_privilege`, and check that the role switch works.
3. **The staging master user cannot SET ROLE authenticated.** Acceptance must log in as `authenticator`, as the
   PostgREST proxy does (`ACCEPT_DATABASE_URL`, host-guarded like `PGHOST`).
4. **USAGE on `auth` and the extension schemas.** Copy it from the source for anon/authenticated/service_role. Stored
   policies and defaults work without it, but any function that names `auth.uid()` at run time fails with
   `permission denied for schema auth`.
5. The earlier ones from package A still apply to any `pg_dump`/`pg_restore` path:
   - run `pg_restore --no-owner --no-privileges`;
   - drop grants on excluded objects;
   - put `RESET ALL` after the dump's `search_path=''`;
   - suppress `SET` tags (`psql -q`);
   - exclude policies over `auth.*` or unknown roles, indexes on excluded materialized views, and functions typed by
     excluded views;
   - refuse `PGHOSTADDR` and `PGSERVICE`;
   - move a 6543 pooler URL to 5432.
6. **Do not keep public → auth.users foreign keys on an empty `auth.users` stub.** Every member insert then fails
   (`violates foreign key constraint … not present in table "users"`), including auth-bridge provisioning. Also do not
   change the shared `scripts/aurora/migrations/0001_auth_shim.sql`.

## Acceptance (`stage-accept.sql`, run after restore, one transaction that always rolls back)
- A0: the login can SET ROLE the three API roles.
- A1: structure: fk map loaded, no pg_cron, pg_net or http, API roles subject to RLS, auth bridge and outbox present.
- A2: `auth.uid()` from `request.jwt.claims`.
- A3: two synthetic members provisioned through `provisioning_pre_request()`.
- A4: member A cannot update or delete member B.
- A5: anon reads no `app_users` rows.
- A6: service_role reads both members.
- A7: auth-bridge deletion of A applies every CASCADE in the map and leaves B untouched.
- A8: no trigger calls pg_net or http directly.
- A9: nothing persisted, then `NOTIFY pgrst, 'reload schema'`.
