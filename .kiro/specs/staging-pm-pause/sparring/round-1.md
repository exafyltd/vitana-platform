# Sparring round 1 — in_progress

Session: `6942a00c-6c48-405b-9d2f-de0b03dd44c9` · plan hash `9230032d71e7eba443a85b553a38a59a2bb514e79c7c08fcc4b82f29710772e0`

## Summary

Clean, well-scoped one-line config change. All core premises verified against the pinned commit. The staging workflow at line 1229 does set PM_MODE=live, the loop guard at index.ts:1882 does check `pmMode() !== 'off'`, the `pmMode()` function in config.ts correctly returns `'off'` for that input, and the production workflow does not set PM_MODE. One minor finding about merge-triggered deploy sequencing clarity.

## Findings

### R1-F1 [minor]

The plan's 'Owner action for the running task' section does not mention that merging this PR will itself auto-trigger a staging deploy (because the workflow file's own path `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` is listed in the `on.push.paths` trigger at line 39). That deploy will register a new task-definition revision with PM_MODE=off and roll the service, making the manual ECS update partially or wholly redundant. The plan should clarify sequencing: is the owner action for immediate relief before the PR merges, or is it the primary mechanism?

- `exafyltd/vitana-platform:.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:34` — on:
  push:
    branches: [main]
    paths:
      - 'services/gateway/**'
      - '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'

Suggestion: Add a note clarifying that the merge itself will trigger a staging deploy that sets PM_MODE=off, and that the manual owner action is either (a) an immediate mitigation applied before merge to stop the loop sooner, or (b) a redundant safety step — whichever is intended.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
