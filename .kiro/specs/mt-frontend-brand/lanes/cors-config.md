---
lane: cors-config
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: exafyltd
paths:
  - services/gateway/src/middleware/cors.ts
  - services/gateway/test/middleware/cors.test.ts
updated: 2026-10-21T17:54Z
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
### 2026-10-21T14:05Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:07Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:09Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:11Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:13Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:15Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:17Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:45Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:47Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:49Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:51Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:53Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:55Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:57Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T14:59Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:01Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:04Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:08Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:10Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:12Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:14Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:16Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:18Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:20Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:44Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:46Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:48Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:50Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:52Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:54Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:56Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T15:58Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:00Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:02Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:04Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:06Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:08Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:10Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:12Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:14Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:16Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:18Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:44Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:46Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:48Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:50Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:52Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:54Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:56Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:58Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:00Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:02Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:04Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:06Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:08Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:10Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:12Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:14Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:16Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:44Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:46Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:48Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:50Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:52Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:54Z · pm-agent · update
reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)
