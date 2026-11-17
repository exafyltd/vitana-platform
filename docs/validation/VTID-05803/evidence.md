# VTID-05803 — Aurora staging cutover: evidence record

Status (ledger, read 2026-11-17): `in_progress`. Ledger write not performed from this session (no authenticated gateway session).

## Actions completed (verified, live)

1. **Proxy service** `vitana-postgrest-aurora-proxy` (cluster `Vitana-ECS-Cluster`): single PRIMARY deployment on
   `vitana-postgrest-aurora-staging:19`, 1 running task, `proxy` container HEALTHY. Revision 14 no longer in service.
2. **PostgREST → Aurora staging:** PostgREST 12.2.3 connected to PostgreSQL 17.9 (CloudWatch `/ecs/vitana-postgrest-aurora-staging`).
   Schema cache loaded 0 relations: the `public` schema is empty.
3. **Authenticated read against Aurora staging (read-only):** database `vitana`, user `authenticator`, server 10.0.10.108.
   The IP's RDS interface sits in subnet `subnet-0ff45a2051c5e5482`, which belongs to subnet group
   `vitana-aurora-staging-subnets` and not to `vitana-aurora-subnet-group` (production). Public tables: 0.
4. **Temporary probe task definitions** `vitana-aurora-staging-probe` revisions 1–4: read-only queries only. All four
   revisions are now deregistered (reported by the owner). No ECS service or running task referenced them.
   ECS task definitions are deregistered, not physically deleted.

## Findings that block the live restore

- **`authenticator` is not DDL-capable.** Read-only check: not superuser, no CREATEDB, no CREATEROLE, no BYPASSRLS, no
  database-level CREATE. It is not used for schema restoration.
- **`vitana/aurora/staging/database-url` is stale.** It resolves to `vitana-postgres-staging`, a legacy RDS PostgreSQL
  instance in status `inaccessible-encryption-credentials`. It is not the Aurora staging writer.
- **`vitana/aurora/staging/master-password` has tag `Environment=prod`.** Its name says staging, but the tag says
  production. Its intended target is unverified, so it has not been used. Last changed 2026-07-02.
- **Production runner.** `scripts/aws/aurora-run-sql.sh` targets cluster `vitana-aurora-prod` with its master secret.
  It must not be used for staging.
- **Schema-parity task definitions** (`vitana-schema-parity-batch0–3`, `vitana-schema-parity-oneoff`) use
  `vitana/aurora/prod/database-url`. They are production DDL and were not run.

## Preview gateway

`vitana-gateway-preview` (desired 0, task definition 1) is stopped. Its task definition wires `SUPABASE_URL` to
`http://postgres-aurora.vitana.internal:8080` (the proxy) and has no Supabase service role. This session's identity is
denied `ecs:UpdateService`, so the service was not started. No gateway completion is claimed.

## Migration

Not executed. No schema, data, functions, triggers, sequences, grants, RLS or outbox changes have been applied to
`vitana-aurora-staging`. Synthetic rehearsal evidence is preserved and is not a live migration.

## Single remaining dependency

A DDL-capable staging connection must be provisioned through the authorised Secrets Manager path. The intended secret is
`vitana/aurora/staging/database-url`, which must resolve to `vitana-aurora-staging-writer` with a privileged role. Its
current target is `vitana-postgres-staging` (stale). Until it is repointed, the restore cannot start.
