# CTRL-SCHEMA-0002 — VCAOP data model (runbook Sec. 4.1–4.7)

Adds the 16 VCAOP tables to the OASIS Postgres schema **in place** (does not fork).
`oasis_events` is reused as the audit ledger (Sec. 4.7).

## Files
- `migration.sql` — UP. Canonical SQL generated from `prisma/schema.prisma` via
  `prisma migrate diff` (so it matches the Prisma models exactly). Creates:
  business_identity, provider, provider_account, provisioning_job, job_step,
  job_attempt, job_artifact, human_task, account_health_snapshot,
  affiliate_program, commission_event, rewards_ledger, user_reward_link,
  cart_order, merchant_route, disclosure.
- `down.sql` — ROLLBACK. Drops only those 16 tables (CASCADE); leaves the OASIS
  tables intact.

## Rollback (Sec. 0.7 — recorded + tested)
Reversible. To roll back on the dev DB:
```bash
psql "$DATABASE_URL" -f prisma/migrations/20260604_vcaop_ctrl_schema_0002/down.sql
```
Verified `up → down → up` on a fresh ephemeral Postgres 16 (3 → 19 → 3 → 19
tables). `prisma validate` passes.

## Guardrail compliance (verified)
- Every secret-bearing column is a `*_ref`/`*_hash` only (no-credential-store).
- `user_reward_link` has no credential field (loyalty-guard / Sec. 4.6).
- `user_id` / `tenant_id` are external text references (no cross-schema FK),
  matching the `oasis_events.tenant` convention.

## Deferred to later VTIDs (intentional separation)
- **RLS enable + policies** → `IAM-ROLES-0001` (Sec. 5). Tables are created here;
  row-level isolation is applied with the role matrix there.
- **OASIS-append-in-same-transaction-as-read-model-write** → enforced in the
  repository/service layer in `CTRL-API-0004` (the schema enables it; the tx
  discipline is application code).

## Live-apply status
Not yet applied to a real dev Supabase DB — see `vcaop/BLOCKERS.md` BLK-001
(no reachable dev DB in this environment). Verified against ephemeral Postgres
instead; live apply + down-verify on the dev DB is a runtime step.
