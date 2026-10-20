---
lane: theme-tokens
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - src/index.css
  - src/hooks/useTenant.tsx
  - src/lib/tenant-registry.maxina-golden.test.tsx
  - src/lib/tenant-theme.ts
  - src/lib/tenant-theme.test.ts
  - packages/tokens/**
  - packages/core/src/extracted/**
  - docs/SCREEN_INVENTORY.md
updated: 2026-10-19T20:32Z
vtid: VTID-05246
---
# theme-tokens — tenant theme actually renders (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `theme-tokens` section of `tasks.md`
(T1–T5, allowed paths, acceptance). Design + successor rules: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID.** `next_actor: owner` is the hold; PLAN-SPAR
flips it to `kiro` when it allocates the VTID. Do not build before then.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md` or another lane, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes.
Work only inside the allowed paths; `gen-tokens.mjs` reads custom props only in `:root`/`.dark`,
so add brand props there only. The lane adds its own `docs/validation/<vtid>/` (scope.json,
staging-tests.json, plan copy). Branch `kiro/mt-frontend-brand/theme-tokens`; PR title
`VTID-xxxxx (mt-frontend-brand/theme-tokens): …`; commit trailers `Collab-Session: <id>` and
`Collab-Lane: mt-frontend-brand/theme-tokens`. On PR open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held (`next_actor: owner`). Premise: `useTenant.tsx:124-133` sets `--brand-*`;
golden `tenant-registry.maxina-golden.test.tsx:172-183` confirms nothing consumes them yet (C2).
Reviewer seat `jtadic` (≠ build seat `exafyltd`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05246 allocated after policy approval (converged-auto-v1).
