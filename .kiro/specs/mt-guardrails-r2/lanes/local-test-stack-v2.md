---
lane: local-test-stack-v2
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
updated: 2026-11-02T13:10Z
repos: [exafyltd/vitana-platform]
---
# D11 local Supabase stack + fixtures, with its CI spike job — mt-guardrails-r2/local-test-stack-v2
Supersedes `local-test-stack` (never built): same tasks, pins and rules (see that lane file and `tasks.md`), plus
`.github/workflows/MT-LOCAL-STACK.yml` so the T0 boot-and-replay spike runs on the lane's own PR (no container
runtime on the build hosts). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-02T13:10Z · kiro-hotmail-202611011452-6d16 · created
Created through `_plan`; the build hosts cannot run `docker run`.
