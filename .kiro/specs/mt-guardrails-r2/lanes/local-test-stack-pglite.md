---
lane: local-test-stack-pglite
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
  - .github/workflows/MT-LOCAL-STACK.yml
  - package.json
  - pnpm-lock.yaml
updated: 2026-11-02T20:43Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05520
---
# D11 local stack on PGlite — mt-guardrails-r2/local-test-stack-pglite (repo vitana-platform)

This lane builds the D11 local stack in-process on PGlite, one database per test file, as Amendment 2 of `.kiro/specs/mt-guardrails-r2/plan.md` decides. The Docker replay of `local-test-stack-v2` (PR #4628) did not meet its required tables, so `local-test-stack` and `local-test-stack-v2` are superseded and not built. The lane seeds synthetic fixtures from `supabase/tests/fixtures/`, applies the lanes' migrations in timestamp order with the skips in `supabase/tests/local-stack/replay-skip.json`, and runs the suites through a pgTAP-compatible shim on PGlite in CI with no Docker. Real pgTAP is not used on this stack, and the acceptance in `tasks.md` says so. Tasks P1–P4 and their acceptance are in the `local-test-stack-pglite` group of `tasks.md`. There is no production dump, no live call and no secret. VTIDs come from CI PLAN-SPAR on convergence, never by hand.

## Log
### 2026-11-02T20:00Z · kiro-hotmail-202611011452-6d16 · ready
Created by plan amendment 2 (owner decision, 2026-11-02). No VTID yet.

### 2026-11-02T20:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05520 allocated after policy approval (converged-auto-v1).
