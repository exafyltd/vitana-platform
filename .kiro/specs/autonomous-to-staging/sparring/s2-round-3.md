# Sparring round 3 — converged

Session: `0b4e3562-119e-4eb3-ba4b-7e56caa8118a` · plan hash `cffbfaed050634151ef22858940b86d02c2c22d97068ec946652093e71b337dc`

## Summary

Round 3 review. Both R2-F1 (GATE-INVARIANTS.yml and VTID-ALLOCATE.yml added to protected gate files) and R2-F2 (conditional staging-prod-ref-guard invariant) were accepted and are substantively addressed in the revised plan text. Premise verification against the pinned code confirms the plan's factual claims are accurate. No blocker or major issues found in this revision. One minor finding regarding the `pull_request_target` fork-safety mechanism.

## Findings

### R3-F1 [minor]

The plan says VTID-ALLOCATE.yml gains a `pull_request_target` trigger with `GATEWAY_SERVICE_TOKEN` secret access and `permissions: contents: write`, restricted to 'same-repo branches only.' However, `pull_request_target` fires for ALL PRs including forks, and secrets are available. The plan does not specify the enforcement mechanism (e.g., a job-level `if: github.event.pull_request.head.repo.full_name == github.repository` condition). Without this, a fork PR would receive the `GATEWAY_SERVICE_TOKEN` and `contents: write` token, allowing unauthorized VTID allocation and writes to the base repo.

- `exafyltd/vitana-platform:.github/workflows/VTID-ALLOCATE.yml:35` — GATEWAY_URL: ${{ vars.PLAN_SPAR_GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com' }}
GATEWAY_SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}

Suggestion: Specify in the plan that the `pull_request_target` job carries an explicit `if: github.event.pull_request.head.repo.full_name == github.repository` condition (or equivalent) so the job never runs for fork PRs. Add this condition to the gate-invariants check's assertion list for VTID-ALLOCATE.yml (i.e., the invariant verifies the fork guard is present).
