---
lane: adminfetch-header
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - src/lib/admin-api.ts
  - src/lib/admin-api.test.ts
updated: 2026-10-15T16:40Z
---
# adminfetch-header — adminFetch sends documented tenant headers (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `adminfetch-header` section of `tasks.md`
(AF1–AF2, allowed paths, acceptance). Design: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`/another lane, no merge/approve/deploy/dispatch, no Supabase/AWS writes. Work only
in the allowed paths. Small, isolated change. The lane adds its own `docs/validation/<vtid>/`.
Branch `kiro/mt-frontend-brand/adminfetch-header`; PR title
`VTID-xxxxx (mt-frontend-brand/adminfetch-header): …`; trailers `Collab-Session`/`Collab-Lane`.
On PR open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premise: `admin-api.ts:5-7` JSDoc claims it injects `X-Vitana-Tenant`/
`X-Vitana-Active-Role` but `:33-41` sends only Content-Type + Authorization; gateway CORS
already allows those headers (`cors.ts:71`). Reviewer seat `jtadic` (≠ `exafyltd`).
