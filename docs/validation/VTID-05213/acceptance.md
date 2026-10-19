# VTID-05213 — PM Agent P0: lane schema + Lane scope check

Plan: `.kiro/specs/pm-agent/plan-sparring.md` (v2, CONVERGED, owner Gate 1 "yes" 2026-10-15). CI tooling, spec and
workflow only: no gateway code, no route, no deploy, no OASIS event. This PR also adds the `pm-agent` spec (handoff,
tasks, 8 lanes) as the coordinator's `_plan` commit.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Lane front matter `executor`, `reviewer_seat` (≠ `seat`) and `paths` are validated; a Kiro lane may not declare a governance path; handoff `author_seat` is validated.
  TEST: scripts/collab/queue.test.mjs
AC-2: `queue.mjs scope-check` fails a change outside the lane's paths, a governance path in a Kiro lane, a lane-file edit by a foreign seat, a review entry from a seat other than `reviewer_seat`, and a kiro/ branch without trailers; passes in-scope changes, own spec and own evidence; legacy lanes without paths are report-only; a vitana-v1 PR reads its lane from vitana-platform.
  TEST: scripts/collab/queue.test.mjs
AC-3: `pm-agent` and `ci-plan-spar` are accepted session ids; `pm` is not.
  TEST: scripts/collab/queue.test.mjs
AC-4: Programme registry: front matter validated, a spec in two programmes fails, `queue --program` filters and shows the programme column.
  TEST: scripts/collab/queue.test.mjs
AC-7: `validate` reads a lane file that lives in the other repo through the same fetch (vitana-v1 PRs for platform-hosted plans).
  TEST: scripts/collab/queue.test.mjs
AC-5: All earlier queue/claim/validate behaviour is unchanged (existing 17 tests).
  TEST: scripts/collab/queue.test.mjs
AC-6: PR-GATE has a separate "Lane scope" job in both repos (vitana-v1 fetches queue.mjs and the lane file from vitana-platform main, and skips until this PR is on main).
  TEST: the "Lane scope" check run on this PR (job lane-scope in .github/workflows/PR-GATE.yml) passes for lane pm-agent/p0-lane-scope
