# Sparring round 1 — in_progress

Session: `f1f9716e-3a3c-40a1-9542-906dda729358` · plan hash `96adee3b80a19ee66bde11aec2dffde4422e76fb52edee04d9aeb0b8f9a905fa`

## Summary

Verified 9 of the plan's 10 premises against the pinned commit (premise 2's v1 files are unreachable — no pinned ref for vitana-v1). All verifiable premises hold. The plan is thorough and well-evidenced. I found one major contradiction between the plan text and its lane table regarding a protected gate file, one major issue with a stale dependency on a withdrawn lane, and two minor items.

## Findings

### R1-F1 [major]

The `spar-responder` lane lists `.github/workflows/PLAN-SPAR.yml` in its paths (§19.1), but §6 explicitly says 'with no change to the workflow file (lane `spar-responder`).' PLAN-SPAR.yml is a protected gate file (governance.ts:55). If the lane does modify the file, this is an undisclosed protected-file change that contradicts the plan text. If it doesn't, listing it in paths will cause the lane scope check to flag it as a protected-file change and require class P gate treatment for no reason. Either the path should be removed from the lane or the plan text corrected to disclose the change.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:48` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
    'CLAUDE.md',
    'scripts/collab/plan-spar.mjs',
    ...
    '.github/workflows/PLAN-SPAR.yml',
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:102` — - name: Commit the round
  ... git add .kiro/specs
  ... git push origin "HEAD:${HEAD_REF}"

Suggestion: If the lane truly does not modify PLAN-SPAR.yml, remove it from spar-responder's path list. If a change IS needed (e.g. to invoke the responder or adjust the grace period), disclose it in the plan text and confirm class P treatment applies to the entire lane.

### R1-F2 [major]

The `retire-vtid-allocate` lane's depends_on references the withdrawn lane `vtid-on-pr` (§19.1: 'the cut (D14; its lane file still names `vtid-on-pr`)'). The plan acknowledges this stale dependency in a parenthetical but provides no mechanism to fix it: '_plan commits cannot edit lane files', and the withdrawn lanes are only 'parked by their seats after this plan merges.' A lane whose depends_on names a non-existent lane will either block forever (if the driver checks existence) or fail the lane-scope gate.

- `exafyltd/vitana-platform:.github/workflows/VTID-ALLOCATE.yml:1` — # VTID-ALLOCATE — one-step VTID allocation for Claude Code sessions.
- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:65` — Lanes run in parallel by default; at most 6 build lanes per plan; ... hot files ... are sequenced

Suggestion: State explicitly what `retire-vtid-allocate` depends on after the withdrawal. If it depends on the cut itself (lane `cutover` in plan `agentic-delivery`), say so and update the lane file accordingly. If the lane cannot be defined until after the cut, move it to Wave 2 with a clear trigger.

### R1-F3 [minor]

§16 says 'Keep 4 warm machines in working hours (`fleet_idle_count`)' but fleet.tf default is 0 and no prerequisite, lane or owner action in §17 covers changing this Terraform variable. This requires a Terraform apply by the owner in the engineering account.

- `exafyltd/vitana-platform:infra/gitlab-engineering/terraform/fleet.tf:19` — variable "fleet_idle_count" {
    type        = number
    default     = 0
    description = "Machines kept ready for the next job. 0 means every job waits about a minute for its machine to boot, and nothing is paid while idle."

Suggestion: Add an owner prerequisite or a Wave 2 lane for changing fleet_idle_count from 0 to 4 (via a Terraform apply in the engineering account). Without it, every GitLab job will wait ~1 minute for machine boot, undermining the §16 speed targets.

### R1-F4 [minor]

The plan's review chain (§12, gate M4) is 'Opus 5.5 → Sonnet 5.5 → Opus 4.6 → Sonnet 4.6 → DeepSeek', but the current code in governance.ts and guard.cjs has Sonnet 5.5 FIRST (before Opus), and the last fallback is 4.5, not 4.6. The `reviewer-identity` lane is expected to update this, but the plan doesn't acknowledge it is reversing the reviewer model preference order (from Sonnet-first/cheaper to Opus-first/more expensive) and dropping the 4.5 tier entirely. This affects cost and the review quality profile.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:39` — export const REVIEWER_AGENT_MODELS: readonly string[] = Object.freeze([
    'claude-sonnet-5.5',
    'claude-opus-5.5',
    'claude-sonnet-4.5',
]);
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:106` — const REVIEWER_MODELS = Object.freeze(['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);

Suggestion: Acknowledge in the plan that the reviewer-identity lane reverses the model preference order and replaces the 4.5 fallback with 4.6, and briefly note why (e.g. D12 requires Opus-first, and 4.6 supersedes 4.5).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
