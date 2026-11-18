# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Option (b). plan.md §7 now states that before the cut only A1 has a CI path without a plan (VTID-ON-PR in vitana-v1, using v1's own frontendSimpleViolations), and that A2 and the classes table take effect on GitLab when gitlab-mr-vtid lands; until then a docs- or tests-only change goes through a plan( PR as today. This keeps the GitHub interim to one workflow in one repository and adds no dependency of vtid-on-pr on change-classes.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Option (b), as a separate lane. plan.md §9 retires VTID-ALLOCATE.yml: it allocates for any caller with dispatch rights and checks no class, so under the one rule it has no use; Claude Code uses PLAN-SPAR and VTID-ON-PR like every other seat. New lane retire-vtid-allocate (vitana-platform, path .github/workflows/VTID-ALLOCATE.yml, depends_on vtid-on-pr, so the frontend-simple path exists before the old one goes); rules-platform removes the workflow from the rule texts. Added to §19.1, tasks.md and lanes/retire-vtid-allocate.md.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Premise 9 now uses infra/gitlab-engineering/terraform/fleet.tf and infra/gitlab-engineering/terraform/fleet-classes.tf.",
    "deferred_to": ""
  }
]
```
