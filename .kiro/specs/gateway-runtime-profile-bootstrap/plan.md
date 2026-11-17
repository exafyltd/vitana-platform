<!-- plan:begin -->
# Plan: gateway-runtime-profile-bootstrap

## Goal
Put the guarded gateway (PR #5110, `GATEWAY_RUNTIME_PROFILE`) on `main`, so the existing
staging deploy path can run it on the isolated preview service `vitana-gateway-preview`
with the profile `preview-sparring`.

## Guard (verified on PR #5110 head 3b620c76)
- The only switch is `GATEWAY_RUNTIME_PROFILE`: `full` (default) or `preview-sparring`; any other value refuses to start.
- In `preview-sparring` the listen callback returns before background work.
- Module-level timers go through `scheduleBackground`, which starts nothing in that profile.
- Import-time voice warm-ups are gated on the same profile.
- Runtime tests: 17/17 pass on the branch.

## Route to main (normal governed path)
1. Plan PR (this one) is spared by CI PLAN-SPAR and approved by policy or owner Gate 1.
2. Allocate a VTID for the code change through the existing allocator.
3. Code PR #5110 is reviewed and passes its checks, then merges to `main`.

## Dependency
PLAN-SPAR needs a healthy gateway. The guarded gateway is not deployable until it is on `main`. This is the
circular dependency. The only existing exception is the P1 break-glass rule (CLAUDE.md IF-THEN/rule 55), which is
owner-allocated and not used here.

## Deploy step (after merge; not started by this plan)
- Re-enable `AWS-STAGE-DEPLOY-GATEWAY.yml` (currently `disabled_manually`) through the owner-controlled repository setting.
- Dispatch from `main` with `runtime_profile=preview-sparring` and `ecs_service=vitana-gateway-preview`.

## Out of scope
- No production change, no OIDC trust change, no credentials, no static keys.
- The preview service stays at desired count 0 until the guarded image is on `main` and deployed through that path.

## Test plan
- PR #5110 runtime tests (17) stay green.
- After merge: the staging deploy from `main` reaches `vitana-gateway-preview` with runningCount 1, `/alive` 200,
  and the guard line in logs.
<!-- plan:end -->
