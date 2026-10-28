# VTID-05192 — Collaboration protocol: fixed roles (Claude Code controls, Kiro implements)

Owner decision 2026-10-14 (Gate 1 yes). Sparring: `plan-sparring.md` (CONVERGED, 2 rounds, standard class).
Docs/governance only: no gateway code, no route, no deploy, no OASIS event.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `.claude/rules/collaboration.md` §7 states the fixed default roles (Claude Code authors, coordinates, reviews, merges, sends Gate 1/Gate 2; Kiro executes lanes) and §7a lists what the executor never does; §8 covers Kiro Web with a single-repo fallback.
  TEST: grep -n "Default roles — fixed" .claude/rules/collaboration.md && grep -n "## 7a. What the executor never does" .claude/rules/collaboration.md
AC-2: The always-included Kiro steering file carries the role and the full §7a list inline (no `.claude/rules` link from an `inclusion: always` file), and every steering link still resolves.
  TEST: scripts/ci/kiro-steering/guard.test.cjs
AC-3: `.claude/rules/collaboration.md` is byte-identical in `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
  TEST: diff vitana-platform/.claude/rules/collaboration.md vitana-v1/.claude/rules/collaboration.md
AC-4: No handoff or lane file is changed and the collab queue validates.
  TEST: scripts/collab/queue.test.mjs
