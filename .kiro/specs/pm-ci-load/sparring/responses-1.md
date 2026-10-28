# Responses to sparring round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "§4 now lists 'Variables: read' explicitly for actions/variables/:name (observe-live.ts:705-714) and drops 'Actions: read' and 'Commit statuses: read', which no PM call needs (§2.4: the only /actions/ call is the variables endpoint; check-runs need 'Checks: read'). Least privilege is tighter and the CLAUDE_AVAILABLE read keeps working.", "deferred_to": ""},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The group key is now exactly the PR-GATE.yml pattern, `<workflow>-${{ github.event.pull_request.number }}`, with no github.ref fallback; the test asserts that form.", "deferred_to": ""}
]
```
