# IAM-ROLES-0001 — VCAOP Row-Level Security (runbook Sec. 5)

DB-level enforcement of the role matrix, complementing the Gateway authz
middleware (`services/vcaop/src/api/authz.ts`) — defense in depth.

## Identity source
Policies read request GUCs that Supabase populates per request:
- `request.jwt.claim.sub` → user id (`auth.uid()`)
- `request.jwt.claim.vcaop_role` → app role (`community|staff|admin|developer`)

In Supabase, add `vcaop_role` to the JWT claims. Locally these GUCs are settable
with `SET`, which is how the RLS verification exercises the policies.

## Role matrix (enforced by 20 policies across 16 tables)
| Role | User-facing tables (rewards/cart/links) | Back-office tables | Catalog (provider/affiliate) | human_task |
|------|------|------|------|------|
| community | own rows only | none | none | none |
| staff | all | read+write | read | read+create, **cannot approve** |
| admin | all | read+write | read+write (policy edits) | read+create+**approve** |
| developer | own rows only | none | read-only | none |

## Files
- `migration.sql` — UP: helper fns `vcaop_uid()`/`vcaop_role()`, `ENABLE`+`FORCE`
  RLS, and the policies.
- `down.sql` — ROLLBACK: drop policies, `DISABLE` RLS, drop helper fns.

## Rollback (Sec. 0.7 — recorded + tested)
```bash
psql "$DATABASE_URL" -f prisma/migrations/20260605_vcaop_iam_roles_0001/down.sql
```
Verified `up → down → up` on ephemeral Postgres 16: 20 policies → 0 (+0 helper
fns) → 20.

## Verified behaviors (ephemeral Postgres, as non-superuser `app_user`, RLS forced)
- community u1: sees own rewards/cart (1 each), 0 back-office, 0 human_task.
- staff: sees all rewards (2) and human_task (1); UPDATE human_task → **0 rows**
  (cannot approve); UPDATE provider → **0 rows** (cannot change policy).
- admin: UPDATE human_task → 1 (approve); UPDATE provider → 1 (policy edit).
- developer (owns nothing): reads provider catalog (1); 0 rewards; 0 back-office.

## Live-apply status
Not yet applied to a real dev Supabase DB — see `vcaop/BLOCKERS.md` BLK-001.
Verified against ephemeral Postgres instead. Depends on CTRL-SCHEMA-0002 (tables
must exist first).
