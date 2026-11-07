---
lane: content-overrides-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql
  - supabase/tests/mt/mt_packs_tenant_content_overrides.sql
  - scripts/ci/migration-drift-baseline.json
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-02T16:24Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05495
---
# content-overrides-db — WS5 `tenant_content_overrides` (DB) — mt-packs-r2

Plan: `../plan.md` (Re-plan answers, Fix, Migrations). Tasks, paths and acceptance are in `../tasks.md`
(`<!-- lane: content-overrides-db -->`). The VTID comes from PLAN-SPAR on convergence, never by hand.

Scope:
- Create `tenant_content_overrides(tenant_id, locale, key, value, updated_by, updated_at)`, with PK
  `(tenant_id, locale, key)` and an FK to `tenants`.
- It is service-role-only: RLS on, client privileges revoked, the same pattern as the `mt-launch` tables.
- Version `20261101100000`, so it sorts before `mt-launch`'s `20261101110000`.
- Its MIGRATION-QUEUE row goes directly before row 9. `mt-launch` rows 9–10 (VTID-05324) wait for this apply.
- No reader in this spec.

Rules (§7a): a migration file in this PR, and no live write. After merge, Kiro applies it through `RUN-MIGRATION.yml`
only when the owner approves the file and the target database (§7d). Branch `kiro/mt-packs-r2/content-overrides-db`.
PR title `VTID-xxxxx (mt-packs-r2/content-overrides-db): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-packs-r2/content-overrides-db`.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
New lane in the re-plan. It creates the WS5 publish target that `mt-launch` depends on.

### 2026-11-02T16:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05495 allocated after policy approval (converged-auto-v1).

### 2026-11-07T13:20:00Z · agent-vitana-lane-reviewer-202611071317-7d7e · review
review: accept
head: ff0a96b626e57715d1dbc7f4e7e1d7fb75f3db34
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4789
Findings: non-blocking: baseline on this head is stale against origin/main 83f0e0603c (118 without tenant_domains; correct after re-resolve is 119 with both tenant_domains and tenant_content_overrides, plus #4788/#4791 additions); non-blocking: MIGRATION-QUEUE.md row 8a will conflict with #4788/#4791, re-resolve at landing; non-blocking: staging probe GET /api/v1/admin/moderation/reports expecting 401 is valid and read-only but generic, and no table-specific read-only route exists because nothing reads the new table; non-blocking: EXISTING_REF finding from de2209b8fc resolved; non-blocking: CI not independently verifiable here (gh pr checks unavailable), relies on caller's all-green report
Next: the land step merges under §7b after updating to latest main, re-resolving the baseline (count 119, tenant_domains kept) and the queue, re-running checks on that head, and confirming no new conflict; a re-resolve that adds more than these lines needs a fresh review
