---
lane: cors-config
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: exafyltd
paths:
  - services/gateway/src/middleware/cors.ts
  - services/gateway/test/middleware/cors.test.ts
updated: 2026-10-19T20:32Z
vtid: VTID-05243
---
# cors-config — config-driven CORS allowlist (repo vitana-platform)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `cors-config` section of `tasks.md`
(CC1–CC2, allowed paths, acceptance). Design: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`. `cors.ts` is a hot file: ≤20-line change, its own PR, rebased just before merge.

This is `services/gateway/src/**`, NOT a governance path (`.github/**`, `.claude/**`,
`.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`,
`docs/programs/areas.yaml`), so a Kiro lane may change it. Seat `jtadic` (uncovered-platform
gateway work). Keep every current origin in the compiled default; `CORS_EXTRA_ORIGINS` (read
once at module load) only appends to `ALLOWED_ORIGINS`; patterns and the MCP/.well-known rules
stay untouched (tasks CC1, round-1 R1-F1). Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`/another lane, no merge/approve/deploy/dispatch, no AWS writes. The lane adds its
own `docs/validation/<vtid>/`. Branch `kiro/mt-frontend-brand/cors-config`; PR title
`VTID-xxxxx (mt-frontend-brand/cors-config): …`; trailers `Collab-Session`/`Collab-Lane`. On PR
open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premise: hardcoded `ALLOWED_ORIGINS` array + patterns in `cors.ts:7-51`; the
allowed-headers list already includes `X-Vitana-Tenant`/`X-Vitana-Active-Role` (`:71`). Open
question (plan.md): if sparring prefers Claude for platform chrome, flip to
`executor: claude, next_actor: claude`. Reviewer seat `exafyltd` (≠ `jtadic`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05243 allocated after policy approval (converged-auto-v1).
