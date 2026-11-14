# Sparring round 1 — in_progress

Session: `2a196dea-a356-4a81-92d2-aaf696113d6a` · plan hash `52ef345363f9a4038cc462bf8947f7976dc4927d81acedee5c4f6d64b0acd253`

## Summary

Verified 8 premises against the pinned code; 7 hold, 1 has an incorrect shorthand path. The plan is thorough and well-evidenced. Three findings: one major gap in the VTID allocation coverage for the new class A2 on GitHub before the GitLab cut, one major omission about the existing VTID-ALLOCATE.yml disposition, and one minor path reference issue in the premises.

## Findings

### R1-F1 [major]

Class A2 (docs/tests-only) has no VTID allocation mechanism on GitHub before the GitLab cut. §9 defines exactly three allocation paths: PLAN-SPAR (classes B and P), VTID-ON-PR (class A1 frontend-simple, vitana-v1), and the delivery service (all classes, GitLab after the cut). VTID-ON-PR is explicitly described as running `frontendSimpleViolations` and commenting 'needs a plan' when the diff does not qualify. A docs-only or tests-only change would not pass `frontendSimpleViolations` and would receive no VTID. The `change-classes` lane is a dependency of `gitlab-mr-vtid` only, not of `vtid-on-pr`. So between Wave 1 landing and the GitLab cut, a class A2 PR on GitHub is stuck: the plan says it needs no sparring, but the only GitHub-side allocator rejects it.

- `exafyltd/vitana-platform:CLAUDE.md:338` — 51a. **Simple front-end change: VTID → code, no sparring.** Class `frontend-simple` (vitana-v1): the diff is inside `src/**` or `public/**`, touches no deny-listed file...
- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:38` — 6. **Never:** allocate a VTID by hand (only CI PLAN-SPAR allocates);

Suggestion: Either (a) extend VTID-ON-PR to use the new `change-class.mjs` classifier so it can allocate for all class-A diffs (A1 and A2), making `vtid-on-pr` depend on `change-classes`; or (b) state explicitly that A2 does not exist on GitHub before the cut and the work-class table only takes effect after `gitlab-mr-vtid` lands; or (c) widen VTID-ON-PR to cover both v1 and platform PRs if A2 applies to platform.

### R1-F2 [major]

The existing VTID-ALLOCATE.yml workflow (workflow_dispatch, used by Claude Code) is not addressed by the plan. §9's single VTID rule says 'Sessions never allocate one. CI allocates it: PLAN-SPAR for planned work (classes B and P); VTID-ON-PR for a frontend-simple PR on GitHub until the cut; the delivery service when a merge request opens on GitLab after the cut.' VTID-ALLOCATE is a fourth, already-deployed allocation path that is not mentioned, leaving it unclear whether it stays, is disabled, or is superseded. If it stays, the 'one rule' is not one rule; if it is to be disabled, no lane covers it and no cutover step lists it.

- `exafyltd/vitana-platform:.github/workflows/VTID-ALLOCATE.yml:1` — # VTID-ALLOCATE — one-step VTID allocation for Claude Code sessions.
#
# A session starts this workflow with a title. CI holds the gateway service token, so the session never needs it.
- `exafyltd/vitana-platform:.github/workflows/VTID-ALLOCATE.yml:55` — body=$(jq -n --arg title "$TITLE" --arg module "$MODULE" \
  '{source: "claude-code", layer: "DEV", module: $module, title: $title}')

status=$(curl -sS -o resp.json -w '%{http_code}' -X POST "${GATEWAY_URL}/api/v1/vtid/allocate"

Suggestion: Add VTID-ALLOCATE.yml to §9 with one of: (a) 'kept for Claude Code class-B/P tasks that start outside a plan PR, retired at the cut' and add it to the cutover list; (b) 'disabled by `rules-platform`; Claude Code uses VTID-ON-PR like every other seat'; (c) left as-is as the Claude Code path, but then the 'one rule' text must name it.

### R1-F3 [minor]

Premise 9 references `terraform/fleet.tf:9-17,48-49,92-110` and `terraform/fleet-classes.tf:18-47`, but these files live at `infra/gitlab-engineering/terraform/fleet.tf` and `infra/gitlab-engineering/terraform/fleet-classes.tf`. The shorthand path fails to resolve at the repo root (`terraform/fleet.tf` returned a 404).

- `exafyltd/vitana-platform:infra/gitlab-engineering/terraform/fleet.tf:9` — variable "fleet_max_instances" {
  type        = number
  default     = 24
  description = "Most job machines at the same time. Also `concurrent` and `max_instances` of the runner. Needs fleet_max_instances x 4 vCPUs in both Standard quotas."
  validation {
    condition     = var.fleet_max_instances >= 1 && var.fleet_max_instances <= 500 && var.fleet_max_instances == floor(var.fleet_max_instances)
    error_message = "fleet_max_instances must be a whole number from 1 to 500."
  }
}

Suggestion: Use full repo-relative paths in the premises section: `infra/gitlab-engineering/terraform/fleet.tf` and `infra/gitlab-engineering/terraform/fleet-classes.tf`.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
