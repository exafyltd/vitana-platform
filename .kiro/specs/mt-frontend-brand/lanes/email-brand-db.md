---
lane: email-brand-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafyltd
paths:
  - supabase/migrations/20261101090000_vtid_xxxxx_tenant_email_branding.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-10-19T20:32Z
vtid: VTID-05245
---
# email-brand-db — tenant-keyed email branding helper (repo vitana-v1, DB)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `email-brand-db` section of `tasks.md`
(ED1–ED2, allowed paths, acceptance). Design + migration rules: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`. The migration file name's `vtid_xxxxx` is renamed to the allocated VTID at build time;
renumber the `20261101090000` prefix if a later migration exists then.

Executor rules (collaboration §7a): a DB change is a migration FILE in this PR — Kiro never
applies it, never runs `apply_migration`/`execute_sql` DDL, never writes to a live system.
Claude applies it via RUN-MIGRATION after merge, with the read-only pre/post checks. Expand-only
(a read helper/view, seeded with Maxina's current literal values); `SET lock_timeout`; no NOT
NULL, no hot-table backfill. Add the MIGRATION-QUEUE row as the first `20261101…` entry (after
`20261014000700`), rollback `docs/validation/<vtid>/rollback.sql`. The lane adds its own
`docs/validation/<vtid>/` (rollback.sql, pre/post-check SQL, scope.json). Branch
`kiro/mt-frontend-brand/email-brand-db`; PR title `VTID-xxxxx (mt-frontend-brand/email-brand-db): …`;
trailers `Collab-Session`/`Collab-Lane`. On PR open: `state: in-review`, `next_actor: kiro`,
`pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. DB lane split from `email-brand-code` per §4.7. Seeds Maxina's current email
branding so behaviour is byte-identical until a tenant overrides. Seat `hotmail`
(supabase/migrations + DB lanes per the brief); reviewer seat `exafyltd` (≠ `hotmail`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05245 allocated after policy approval (converged-auto-v1).
