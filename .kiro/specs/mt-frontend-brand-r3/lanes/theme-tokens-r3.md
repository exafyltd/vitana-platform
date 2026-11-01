---
lane: theme-tokens-r3
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/lib/tenant-theme.ts
  - src/lib/tenant-theme.test.ts
  - src/hooks/useTenant.tsx
  - src/hooks/useTenant.theme.test.tsx
  - tests/e2e/staging/vtid-*-theme-tokens.staging.spec.ts
updated: 2026-11-01T15:45Z
---
# theme-tokens-r3 — tenant theme renders via runtime HSL overrides (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand-r3/plan.md` and the `theme-tokens-r3` section of `tasks.md` (TT1–TT4, allowed
paths, acceptance) are authoritative. Supersedes `mt-frontend-brand/theme-tokens` (VTID-05246). VTID: assigned by CI
after PLAN-SPAR converges; do not start before `vtid:` is set here.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane, no
merge/approve/deploy/dispatch outside §7b, no Supabase/AWS/gateway writes. Work only in the allowed paths;
`docs/validation/<vtid>/` is the lane's own. No edit of `src/index.css`, `tailwind.config.ts`,
`scripts/native/gen-tokens.mjs`, `packages/**` or the C2 golden: Maxina gets no inline override (slug guard), so its
built CSS is byte-identical. Overrides are HSL triplets, never hex. Branch `kiro/mt-frontend-brand-r3/theme-tokens-r3`;
PR title `VTID-xxxxx (mt-frontend-brand-r3/theme-tokens-r3): …`; trailers `Collab-Session` /
`Collab-Lane: mt-frontend-brand-r3/theme-tokens-r3`. Deploys (frontend): ships
`docs/validation/<vtid>/staging-tests.json`; done when STAGING-VERIFY passed on its merge commit.
Shared files: none.

## Log
### 2026-11-01T15:45Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-frontend-brand-r2/theme-tokens-r2` under the new slug. Answers R3-F1 (no `--ring`) and R3-F2 (the cleanup removes exactly the keys it set).
