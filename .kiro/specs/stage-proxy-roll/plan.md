<!-- plan:begin -->
# Plan: stage-proxy-roll

## Problem
The staging PostgREST-Aurora proxy deploy (`.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`) rolls the
task definition without a desired count. The service stays at 0, the stable-waiter returns at once, and the smoke step
checks only the image. The job reports success with nothing running. That is why the proxy the staging gateway needs
has been stopped.

## Change (PR #5114, branch claude/fix-stage-proxy-desired-count, head 6f830a0b)
- `update-service` adds `--desired-count 1`.
- The smoke step fails unless `runningCount >= 1`.
- The production-name refusal stays unchanged.

## Files in scope
- `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` (only)

## Test plan
- Workflow YAML parses; the roll and smoke steps change as described.
- Staging run from `main` after merge: the proxy service reaches runningCount 1; `/alive` and `/rest/v1/` answer.
- No production resource is named by the workflow (the existing guard enforces this).

## Verification evidence so far
- Run 44173069166 (from the branch) failed at sts:AssumeRoleWithWebIdentity: the staging role trusts `main` only.
  This is the expected boundary and no workaround is proposed.

## Sparring request
Spar the desired-count change and the trust boundary. The sparring gateway requirement is noted: the guarded
gateway (PR #5110) needs a governed merge before it can serve sparring.
<!-- plan:end -->
