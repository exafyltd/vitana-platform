# VTID-04944 — plan sparring record

Partner: plan-sparring-partner agent (read-only). Class: standard. Rounds: 2. Verdict: CONVERGED. Owner approved 2026-10-07 ("Approve").

# Plan — production deploys keep the VTNA payouts on (pins become "true")

<!-- plan:begin -->
## Change class
standard (touches `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, a deploy file)

## Owner decision (2026-10-07, not to be re-argued)
"Yes, pin them on": production deploys keep `REWARD_SWEEP_ENABLED` and
`AUTOPILOT_ACTION_REWARD_ENABLED` on. Turning them off stays a single dispatch with
`env_overrides={"REWARD_SWEEP_ENABLED":"false","AUTOPILOT_ACTION_REWARD_ENABLED":"false"}`.

## Problem (verified 2026-10-07)
- The prod workflow's step "Build task-definition (reward sweep off)" pins both switches to
  "false" on every deploy (VTID-04896, VTID-04899). The owner turned payouts on 2026-10-06 20:55
  (env-only dispatch); two later publishes by other sessions (07:10 and 07:35 UTC 2026-10-07)
  carried no overrides and silently turned both off again.
- Republished at 08:43 UTC 2026-10-07 (76d4b96) with env_overrides true; the job's verify step
  printed `REWARD_SWEEP_ENABLED=true (expected true)` and
  `AUTOPILOT_ACTION_REWARD_ENABLED=true (expected true)`. The next publish without overrides
  (including a Command Hub PUBLISH) would switch them off again.

## Work
1. `AWS-PROD-DEPLOY-GATEWAY.yml`
   - Rename the step to "Build task-definition (reward payouts on)"; both jq pins write
     `value:"true"`; the comment records the owner decision (2026-10-07) and the off switch.
   - "Verify reward sweep setting": defaults become `EXPECTED=true` and `EXPECTED_AP=true`;
     an explicit env_overrides key still sets the expectation (so an off dispatch verifies
     `false`). The step's header comment is updated. No other step changes.
   - env_overrides stays applied after the pins (step 2/2), unchanged — the off switch keeps
     working.
2. Regenerate `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts`
   with `scripts/conversation/generate-flag-pins.mjs` (prod values become "true"; never by hand).
3. Tests, updated to the new contract, not loosened:
   - `test/vtid-04896-prod-reward-sweep-pin.test.ts`: the pin writes "true" before 2/2; the
     "true" value lets the sweep and its loop run on ECS; "false" (the off override) still stops
     both; the verify step defaults to `EXPECTED=true`, still fails on mismatch, is read-only,
     and still honours an explicit env_overrides key; staging still pins nothing for the sweep.
   - `test/vtid-04899-autopilot-reward-switch.test.ts`: pin writes "true"; generated pins
     `{ staging: 'true', prod: 'true' }` and `REWARD_SWEEP_ENABLED { staging: null, prod: 'true' }`;
     `EXPECTED_AP=true` default.
   - `test/vtid-04897-prod-commerce-mcp-pin.test.ts` line 36: generated pin prod 'true'.
   - New assertion: env_overrides is applied after the payout pin step (index of 2/2 >
     index of the pin), so a `false` override wins.
   - In vtid-04896 the step lookup `at('Build task-definition (reward sweep off)')` becomes
     `at('Build task-definition (reward payouts on)')`, with an explicit `toBeDefined()` first.
   - `test/services/conversation/vtid-04525-conversation-flag-registry.test.ts` runs
     `generate-flag-pins.mjs --check`; it needs no assertion change and passes once step 2's
     regeneration is committed (it fails CI if the generated file is stale).
4. Docs: `.claude/rules/backend.md` §13c rule 8 sentence about the sweep notes the prod pin is
   on (owner decision 2026-10-07) and how to switch off; `docs/validation/<VTID>/`
   (plan-sparring.md, acceptance.md, commands.log, staging-tests.json).

## Rollout
PR -> CI (gateway Jest incl. the three tests and vtid-04525 flag registry) -> merge -> staging
deploy (gateway; staging behaviour unchanged: sweep excluded by VITANA_ENV, autopilot reward
already pinned true there) -> STAGING-VERIFY (read-only: /alive, build-info reports the merged
commit) -> owner's ready message. The workflow file itself is used from `main` on every prod
dispatch, so the new pins apply at the next prod publish by anyone; prod does not need a
publish for this change alone. Proof: the next prod deploy job without overrides prints
`REWARD_SWEEP_ENABLED=true (expected true)` and the autopilot line likewise.

## Risks
- Any prod publish from now on keeps paying; the off switch is an explicit override on each
  dispatch until the pins are changed back. Same shape as Commerce MCP (VTID-04897).
- A dispatch that wants payouts off must remember the override; a forgotten override pays. That
  is the owner's chosen default.
- Changed safety posture (owner's choice, stated plainly): the defaults used to defend against
  paying; now they pay. The verify step defaults to expecting "true", so if the pin block were
  ever dropped from the workflow (e.g. a bad merge), a task definition that already carries
  "true" would still pass the check. Mitigation: the tests assert the pin step exists, writes
  "true" for both keys and runs before 2/2, so a dropped or altered pin fails CI before merge;
  and an explicit `false` override is still verified as `false` after the roll.
- No database or staging behaviour changes; the generated pins file is a data mirror that no
  runtime code reads for these switches (`rewardSweepAllowed()`/`isRuleLive()` read process.env).
<!-- plan:end -->

## Planner responses (round 1)
- F1 major (safety posture changes to "defaults pay"; a dropped pin would pass the verify step): ACCEPTED — Risks now states the changed posture and the mitigation (CI asserts the pin step exists, writes "true" for both keys and runs before 2/2; an explicit false override is still verified).
- F2 minor (step lookup string in vtid-04896): ACCEPTED — named in Work 3 with an explicit toBeDefined() first.
- F3 minor (vtid-04897 scope): acknowledged, no change.
- F4 minor (vtid-04525 --check): ACCEPTED — named in Work 3.
- F5 minor (generated file is compiled code): ACCEPTED — Risks wording corrected.
- Q1: yes, explicit. The owner chose the option reading "Small workflow change under its own sparred VTID: the pins become \"true\" and the post-deploy check expects true. Turning off stays a single env_overrides=false dispatch." (2026-10-07).
- Q2: intentional. The owner approved on as the production default; activation at the next publish by anyone is the point (payouts were switched off twice by unrelated publishes). Payouts are already on in production since 08:43 UTC today, so that next publish keeps the current state rather than changing it.

## Round 2 (partner)
F1-F5 closed; Q1/Q2 answered; no new findings.

## Verdict
CONVERGED after 2 rounds (standard class). Plan hash: ff63cad719531e45ce6fefd1c20c892b96657936c0de247988a84bd93b98633a

## Round 1 findings (partner, verbatim summary)
- F1 major: the safety posture changes from "defaults defend against paying" to "defaults pay"; with EXPECTED=true the verify step would pass if the pin block were dropped and the previous task definition already carried true. Plan should state it and its mitigation.
- F2 minor: name the step-lookup string change in vtid-04896.
- F3 minor: vtid-04897 scope correct.
- F4 minor: name vtid-04525 (generate-flag-pins --check).
- F5 minor: the generated pins file is compiled code (data mirror).
- Q1: owner explicitly chose per-dispatch off? Q2: activation at next publish intentional?
