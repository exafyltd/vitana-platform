---
slug: ci-gate-invariants
author: kiro
executor: kiro
next_actor: claude
state: parked
author_seat: exafyltd
updated: 2026-11-13T13:09Z
parked_from: drafted
---
# Handoff — ci-gate-invariants

Plan block: `plan.md`. Tasks: `tasks.md`. Lane: `lanes/bootstrap-pack-rules.md`. Sparring record: `sparring/` (written by CI).

## State at drafting
- Owner goal: bundle #5050, #5068 and #5070 into one plan PR and spar it. Kiro carries one lane, `bootstrap-pack-rules`
  (#5070), because the other two are not needed on `main` (`plan.md` Today, Decision 1).
- `loop-catalog` (#5050): the change is already on `main` at `575d70e9ae` (VTID-05785). The PR has no diff.
- `plan-sparring-wording` (#5068): not needed for green. It would edit an existing test, which the planning brief forbids.
- `bootstrap-pack-rules` (#5070): the only change not on `main`. It has no Collab trailers (`43ace0d89`), so this plan
  does not reuse its commit. The lane builds it again with trailers.
- VTIDs: VTID-05792 is named for the lane in the body text. The `vtid:` key is written by CI on convergence.
- Held and out of scope: #5069 (VTID-05793, draft, owner-held migration).

## What Kiro does next
1. PLAN-SPAR runs on the `plan(ci-gate-invariants)` PR. Kiro answers each round in `sparring/responses-<n>.md`.
2. On convergence, CI writes the lane's `vtid:`. Kiro does not start the lane before that.
3. Build `bootstrap-pack-rules` (B1 red test first, then B2–B4).

## Waiting on the owner
- Whether #5050 and #5068 are closed as superseded. Kiro has not closed them.
- Whether the Autonomy Contract may leave the operator pack (plan Risk 1). Sparring decides this first.

## Log
### 2026-11-13T11:20Z · kiro-exafyltd-202611072144-1c88 · created → drafted
Plan written after #5050, #5068 and #5070 were checked against `origin/main` (vitana-platform `4c4694b79`, vitana-v1 `17a32ed80`).

### 2026-11-13T13:09Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (evidence_floor_not_met). Parked with the open findings in sparring/.
