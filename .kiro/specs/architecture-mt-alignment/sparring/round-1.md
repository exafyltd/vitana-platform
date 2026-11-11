# Sparring round 1 — in_progress

Session: `bf2565e9-8e72-49a7-8265-661f1eeef69a` · plan hash `7edc4098f4c0cfe33c9bf6762adf1cdef2af085d4c32153210a390ed4438019e`

## Summary

This is a low-risk, documentation-only plan with two parallel lanes that read code at pinned commits and produce markdown reports (architecture map verification and multi-tenant alignment analysis). No code, schema, migration, flag, or RLS changes. Key premises about the repository structure, the multi-tenant program, the collaboration protocol, and seat assignments all hold. Two minor issues found: (1) the plan references Wave 1 VTIDs that do not exist at the pinned commit or on the default branch, and (2) the "18 workstreams" count is sourced from an external GitLab repository and cannot be verified from the platform repos alone. Neither blocks the plan.

## Findings

### R1-F1 [minor]

The plan claims 'Wave 1 already covers destination identity (VTID-05689, PR #4944) and Healthy Million readiness (VTID-05690, PR #4950)' but neither VTID exists at the pinned commit. The highest allocated VTID in `docs/validation/` is VTID-05542, and GitHub code search returns no hits for either VTID on the default branch. The coordination statement 'this plan does not repeat them and cites them' references work that is not verifiable at either the pin or HEAD.

- `exafyltd/vitana-platform:docs/validation/VTID-05542/scope.json:1` — {
  "vtid": "VTID-05542",
  "kind": "infra",

Suggestion: Either confirm these VTIDs exist on an open PR/branch and cite that branch SHA, or remove the Wave 1 coordination claim until those VTIDs are allocated and verifiable. The plan's own output should not depend on unverifiable sibling work.

### R1-F2 [minor]

The mt-alignment lane says 'for each of the 18 workstreams' but the MULTI-TENANT-PLAN.md in this repository only explicitly names WS-S and WS0–WS11, which is 13 distinct workstream identifiers (visible in the §9 estimate table). The '18' presumably comes from the strategy repository's `module-ownership.json` `workstream` field on GitLab, which is unverifiable from the platform repos. If the count is wrong the lane's completeness criterion ('18 of 18 workstreams in the alignment table') silently passes or fails.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:136` — | Item | PRs | VTIDs | Session-days | Weeks |
|---|---|---|---|---|
| Track S ... | M0 foundation (WS0, WS1 shadow, WS2 expand) | M1 ... (WS3 ... WS4, WS5, WS7) | M2 ... (WS6, WS8 ..., WS11 v1...) | WS9 ... | WS10 ... | WS11 full ... |

Suggestion: Pin the workstream list explicitly in the plan (either enumerate all 18 names or cite the strategy repo field + SHA where they are defined), so the completeness criterion is mechanically checkable from the plan text alone.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
