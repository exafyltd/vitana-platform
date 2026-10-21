# VTID-05145 — Claude Code ↔ Kiro collaboration protocol

Owner decision 2026-10-13 (Gate 1 yes). Sparring: `plan-sparring.md` (CONVERGED, 5 rounds, standard class).
CI/governance tooling only: no gateway code, no route, no deploy, no OASIS event.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The queue lists one row per lane across both repos (plan row + lanes), newest version across main and recent branches, `blocked` for unmet dependencies, and a spec without lanes as one implicit lane `main`.
  TEST: scripts/collab/queue.test.mjs
AC-2: Claims are atomic per lane: a second session's claim of a held lane is refused and names the holder; other lanes of the same spec can be claimed in parallel; release only by the holder or `--stale` after 24 h; nested claim refs are listed.
  TEST: scripts/collab/queue.test.mjs
AC-3: Handoff and lane front matter are validated (enums, required keys, plan-only states rejected in lane files, deps exist, session-id format) and every state change follows the plan / lane transition tables; `done` is terminal; `parked` returns only to `parked_from`.
  TEST: scripts/collab/queue.test.mjs
AC-4: PR validation fails on a foreign lane file, a branch/lane mismatch, `claimed_by` ≠ the commits' `Collab-Session`, missing trailers in a lane PR, two lanes in one PR, and an illegal transition; a reviewer may append with `Collab-Review` but not change front matter; a coordinator `_plan` commit may create but not edit lanes; a new spec must start `drafted` unless `collab_allow_initial` is set in this PR's scope.json.
  TEST: scripts/collab/queue.test.mjs
AC-5: Kiro twin of `.claude/rules/collaboration.md` exists with the same paths and links resolve.
  TEST: scripts/ci/kiro-steering/guard.test.cjs
