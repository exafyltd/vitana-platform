# Sparring round 1 — in_progress

Session: `f9e116fc-0ea7-422b-be01-33e9116e5f95` · plan hash `88ecad8dfdd6c33fe7714c93c79c77dfe62ef087ff6508e939db034c241fb4e9`

## Summary

The plan is well-structured and all five stated premises verify against the pinned code. The proposed changes (disabling the PM loop via env vars and adding concurrency blocks to three gate workflows) are sound and correctly scoped. One minor factual inaccuracy found: the proposed concurrency group expression does not match what TEST-SUITE.yml actually uses, though the proposed expression is functionally correct for the purpose.

## Findings

### R1-F1 [minor]

The plan states the proposed concurrency group expression "is the expression TEST-SUITE.yml already uses", but TEST-SUITE.yml uses a different group key: `test-suite-${{ github.event_name }}-${{ github.ref }}` (hardcoded prefix, event_name, ref), not `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` (workflow name, PR number with ref fallback). The `cancel-in-progress` line is the same, but the `group` line is not.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:34` — concurrency:
  group: test-suite-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

Suggestion: Fix the claim. The proposed expression is actually fine (and arguably better for PR grouping since it uses the PR number directly), but drop the false assertion that it matches TEST-SUITE.yml. Alternatively, align with the TEST-SUITE.yml pattern for consistency across workflows.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
