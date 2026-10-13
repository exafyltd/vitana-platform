# VTID-05043 — S3 migrations, verified before they touch the shared database

Staging and production share one Supabase project, so Migrations A, B and C are applied once,
at the production step, through `RUN-MIGRATION.yml` (A, then B, then C), after the owner approves.
Before that, all three and their rollbacks were run end to end against an in-memory Postgres
(PGlite 0.5.8) whose tables mirror the live columns and constraints (read from the live catalog,
read-only, 2026-10-10): `tenants` (maxina, alkalma + a closed `earthlings`), `memberships`,
`role_preferences`, `app_users`, `user_tenants` (unique (tenant_id, user_id), FK to app_users),
`audit_events`, `auth.users` with `auth.uid()` reading `request.jwt.claims`, the live
`switch_to_tenant_by_slug` body and grants, and the four live triggers with stub functions that
log to `side_effect_log`.

PGlite proves the SQL logic only. SECURITY DEFINER behaviour under the real roles and the
production grants are verified after apply by `post-apply-checks.sql` (read-only).

Run it yourself:

```bash
mkdir /tmp/pg && cd /tmp/pg && npm i @electric-sql/pglite
cp <repo>/docs/validation/VTID-05043/pglite-migration-check.mjs run.mjs
node run.mjs <repo>
```

Result (2026-10-10): 69 checks, `ALL MIGRATION CHECKS PASSED` — full output in
`outputs/pglite-migration-check.txt`.

Rollback order: `rollback-s3-switch-tenant.sql`, `rollback-s3-backfill.sql`, `rollback-s3-guard.sql`.
