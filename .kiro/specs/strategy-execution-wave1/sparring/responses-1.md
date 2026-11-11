# Responses — round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Option (b), scoped to the lane that owns the label: plan §4.8 now requires the mental-health-label lane's acceptance.md to list every other surface that names the fifth pillar 'mental' (gateway pillarLabel() at vitana-pillars.ts:29-32 and its call sites, apps/mobile labels, server-shipped UI text) as proposed follow-ups with file:line, and states that the lane does not finish the instruction for those surfaces. Changing pillarLabel() is gateway behaviour on voice paths (NEVER 41 territory) and gets its own sparred plan rather than widening a text-only lane.", "deferred_to": "follow-up plan named in the lane's acceptance.md"},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The vitana-v1 pin was in the header outside the plan block. Both pins (vitana-platform 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835, vitana-v1 e31bf4627ff3c705c20f8e6b718ce4dd03353b7f) are now the first line of the plan block, and a lane starting on a newer origin/main re-verifies its citations there and records both SHAs in commands.log.", "deferred_to": ""},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "Plan §4.3 now requires an explicit autonomy-risk register entry for the event-type gap: self-healing.rollback.completed (self-healing-snapshot-service.ts:460-472) is emitted when only a rollback request was recorded; the follow-up fixes the event semantics as well as the missing rollback mechanism.", "deferred_to": ""}
]
```
