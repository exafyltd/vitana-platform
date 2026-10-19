# VTID-05218 — PM Agent P5: rules, CLAUDE.md, Kiro automations and the routine prompt for the new roles

Plan: `.kiro/specs/pm-agent/plan-sparring.md` (v2 §7, §8, §10; owner Gate 1 "yes" 2026-10-15). Rules and
instructions only — no code, no route, no deploy.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `.claude/rules/collaboration.md` (identical in both repos, linked by the Kiro twin) states the roles: Kiro plans, builds and reviews; CI sparring with policy approval; the Project Manager (until it runs, Claude Code) merges; Claude Code exceptions only; the lane fields executor / reviewer_seat / paths; Lane scope and PLAN-SPAR in §9.
  TEST: scripts/ci/kiro-steering/guard.test.cjs (twin + links resolve) and a byte comparison of the two copies in the PR
AC-2: Both CLAUDE.md files state the new roles; the platform CLAUDE.md Autonomy Contract and rules 51/54 accept the policy approval of a converged CI-sparred plan.
  TEST: review of the diff (rules text; no code path)
AC-3: Each Kiro Web automation does at most one item per run: answer a sparring round of its own plan, review one lane where it is reviewer_seat, or build one lane of its seat inside the lane's paths; it never changes a lane's state as reviewer.
  TEST: review of the diff; the commands it names exist (`queue.mjs scope-check`, `validate`, `session-id --seat`) — scripts/collab/queue.test.mjs
AC-4: The routine prompt limits Claude Code to the exceptions and leaves Kiro lanes alone.
  TEST: review of the diff
