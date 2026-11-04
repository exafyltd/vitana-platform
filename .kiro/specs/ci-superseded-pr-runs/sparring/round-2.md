# Sparring round 2 — converged

Session: `c5212b35-d6bc-44e8-b8a1-1bf3789c8b7a` · plan hash `72b93a5277c536bd263c3cc91aecab9c44bb5605a50a114d03bd2b9cbb18bc0f`

## Summary

The revised plan properly addresses all three R1 findings. The count is corrected to 38 of 45, ENFORCE-FRONTEND-CANONICAL-SOURCE.yml's list-form `on:` is confirmed, the three VTID-05353 workflows (UNIT.yml, TEST-SUITE.yml, PHASE-2B-DOC-GATE.yml) are explicitly excluded, and the Risks section now acknowledges push-triggered branch queuing. One minor documentation gap: the plan says 7 workflows already have concurrency but only explicitly names 5; CALENDAR-REGRESSION.yml is a 6th confirmed one that goes unnamed. Since the lane script auto-skips files with existing concurrency keys this is not a correctness risk. No blockers or major issues found in the revision.

## Findings

### R2-F1 [minor]

The plan states '7 have a block already, including UNIT.yml, TEST-SUITE.yml and PHASE-2B-DOC-GATE.yml' and separately names PR-GATE.yml and PLAN-SPAR.yml as excluded. That accounts for 5 of the 7. CALENDAR-REGRESSION.yml is a 6th PR-triggered workflow with an existing concurrency block (group: calendar-regression-${{ github.ref }}, cancel-in-progress conditional on event_name). The plan should name all 7 for completeness, or at least note that the full list is derived by the script and can be verified in the lane's scope.json.

- `exafyltd/vitana-platform:.github/workflows/CALENDAR-REGRESSION.yml:48` — concurrency:
  group: calendar-regression-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

Suggestion: Either list all 7 excluded-by-concurrency workflows explicitly in the Today section, or state 'the full list is computed by the lane script and recorded in scope.json'. This avoids a future reader wondering whether the count is off again.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The plan now correctly states 38 of 45 and explains the ENFORCE-FRONTEND-CANONICAL-SOURCE miss.
- R1-F2: acknowledged — Accepted and addressed. The plan explicitly names the three VTID-05353 workflows as excluded and confirms the lane script skips files with existing concurrency keys.
- R1-F3: acknowledged — Accepted and addressed. The Risks section now names VCAOP-CICD.yml and VCAOP-GUARDRAILS-CI.yml and explains the deliberate non-cancellation of push-triggered runs.
