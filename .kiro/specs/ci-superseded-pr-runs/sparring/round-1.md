# Sparring round 1 — in_progress

Session: `c5212b35-d6bc-44e8-b8a1-1bf3789c8b7a` · plan hash `49371a60af4ed4837e05f8418e41622b60ce8783a06fe4c025c37fbfe43e7609`

## Summary

The plan's core mechanism (per-PR concurrency group with conditional `cancel-in-progress`) is sound, the protected-gate-file exclusion list is correctly identified, and the PR-GATE.yml / PLAN-SPAR.yml exclusions are verified. However, there are two concrete issues: an off-by-one between the plan's stated count ("37 of 45") and the lane size ("38 workflows"), and the plan fails to account for at least three additional workflows that already have concurrency blocks (UNIT.yml, TEST-SUITE.yml, PHASE-2B-DOC-GATE.yml) beyond the two it names (PR-GATE, PLAN-SPAR). These must be clarified to prevent the lane from silently overwriting existing concurrency patterns.

## Findings

### R1-F1 [major]

The plan states '37 of 45 PR-triggered workflows have no concurrency block' but then declares the platform lane targets '38 workflows'. This off-by-one means either (a) the lane includes a workflow that already has a concurrency block, silently overwriting it with a different group-key pattern, or (b) the 37/45 count is wrong. Either way the implementation scope is ambiguous.

- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:1` — name: unit
on: { pull_request: {} }
# VTID-05353 (plan pm-ci-load): a newer push of the same PR cancels the superseded run (PR-GATE.yml pattern);
# every PR head still runs this required check.
concurrency:
  group: unit-${{ github.event.pull_request.number }}
  cancel-in-progress: true
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:34` — concurrency:
  group: test-suite-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
- `exafyltd/vitana-platform:.github/workflows/PHASE-2B-DOC-GATE.yml:5` — # VTID-05353 (plan pm-ci-load): a newer push of the same PR cancels the superseded run (PR-GATE.yml pattern).
concurrency:
  group: phase-2b-doc-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

Suggestion: Reconcile the count. List explicitly which of the 45 PR-triggered workflows already have concurrency and are therefore NOT touched. The lane file count (38) must equal exactly the number of files the lane modifies; if any of UNIT.yml, TEST-SUITE.yml, or PHASE-2B-DOC-GATE.yml are in the lane, call that out and justify changing their existing concurrency patterns.

### R1-F2 [major]

The plan only names PR-GATE.yml and PLAN-SPAR.yml as having existing concurrency blocks (excluded by protected-gate-files rule). It does not mention UNIT.yml, TEST-SUITE.yml, or PHASE-2B-DOC-GATE.yml, all of which already have concurrency blocks added by a prior plan (VTID-05353). If the lane overwrites these, the concurrency group keys change (e.g., TEST-SUITE.yml's group currently uses `github.event_name` as a dimension while the proposed template does not) and in-flight runs under the old group name would not be cancelled by new runs under the new group name during the transition.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:34` — concurrency:
  group: test-suite-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:5` — concurrency:
  group: unit-${{ github.event.pull_request.number }}
  cancel-in-progress: true
- `exafyltd/vitana-platform:.github/workflows/PHASE-2B-DOC-GATE.yml:6` — concurrency:
  group: phase-2b-doc-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

Suggestion: Either (a) explicitly exclude UNIT.yml, TEST-SUITE.yml, and PHASE-2B-DOC-GATE.yml from the lane because they already have adequate concurrency, or (b) include them intentionally, explain what changes in each case, and ensure the lane's validation test asserts the new pattern is functionally equivalent. Option (a) is safer.

### R1-F3 [minor]

Several workflows that will get the new concurrency block also trigger on `push` to non-main feature branches (e.g. VCAOP-CICD.yml pushes to `claude/**` and `feature/vcaop`). The proposed template sets `cancel-in-progress: false` for all push events, so rapid pushes to the same feature branch queue rather than cancel. This is a deliberate conservatism, not a bug, but it means those branch pushes still compete for runners. The plan's Risks section only discusses PR events and should acknowledge this.

- `exafyltd/vitana-platform:.github/workflows/VCAOP-CICD.yml:11` — on:
  pull_request:
    paths:
      - 'services/vcaop/**'
      - '.github/workflows/VCAOP-CICD.yml'
  push:
    branches:
      - 'claude/**'
      - 'feature/vcaop'
    paths:
      - 'services/vcaop/**'
      - '.github/workflows/VCAOP-CICD.yml'

Suggestion: Add a sentence to the Risks section noting that push-triggered runs to feature branches still queue; the plan intentionally limits cancel-in-progress to PR events to avoid killing main-branch or manual runs.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
