---
lane: tenant-domains-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101140000_vtid_*_mt_tenant_domains.sql
  - supabase/migrations/20261101140000_vtid_*_mt_tenant_domains_rollback.sql
  - supabase/migrations/20261101140100_vtid_*_mt_resolve_tenant_host.sql
  - supabase/migrations/20261101140100_vtid_*_mt_resolve_tenant_host_rollback.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-10-15T16:40Z
---
# tenant_domains table + resolve_tenant host arm — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks D1–D4 in `tasks.md` (allowed paths, acceptance); design in `design.md`.
Creates `tenant_domains` (RLS, no client policy; reserved-slug hosts rejected by a BEFORE INSERT/UPDATE trigger, not a
CHECK) and a separate no-DEFAULT 2-arg overload
`resolve_tenant(p_host text, p_slug text)`; the 1-arg `resolve_tenant(p_slug)` is untouched (pinned byte-identical).
Expand-only; rollbacks + read-only pre/post checks; MIGRATION-QUEUE rows after the live last row (mt-m3 range note); add
`tenant_domains` to `migration-drift-baseline.json` and note its removal in the post-apply PR. The lane adds its own
`docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/workflow
dispatch, no Supabase/AWS writes (a DB change is a migration file in this PR; DB applies are Claude via RUN-MIGRATION).
Work only inside the allowed paths. Branch `kiro/mt-m3/tenant-domains-db`; PR title
`VTID-xxxxx (mt-m3/tenant-domains-db): …`; commit trailers `Collab-Session: <your kiro id>` and
`Collab-Lane: mt-m3/tenant-domains-db`. When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`,
append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID — PLAN-SPAR flips it to `kiro`.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR (VTID allocation). DB lane, seat `hotmail`, reviewer `jtadic`.
