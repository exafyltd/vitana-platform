# Planner responses — sparring round 1

Round 1 was sparred on the plan body of the earlier PR (#5090). Session 85612b1b-8416-44e9-b2de-e45e6c75f3a5, plan hash 3aad74f127447aa56825159afebb01c92c8c6158324d6cd45e9f77c470c5e183.

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Writers are named. CI PLAN-SPAR writes sparring_verdict and plan_hash into the lane's handoff.md front-matter when the session converges. The planner writes protected_files. The predicate's seat inputs come from the existing Collab-Session trailer through the existing seat mapping (seatOf()); Collab-Reviewer-Seat and Collab-Seat are dropped. validatePlan (queue.mjs:196) is extended to accept the three new fields.", "deferred_to": ""},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "PROTECTED_GATE_BUILTIN (queue.mjs:94-98) is in the Phase 3 change. The JSON list, the builtin list and governance.ts PROTECTED_GATE_GLOBS get the same two entries; a parity test asserts the three are identical.", "deferred_to": ""},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "governance.ts hard refusal (lines 191-198) is not changed. The Project Manager keeps refusing every protected gate file and never unlocks one. The predicate applies only where a merge runs through land-guard.mjs and queue.mjs scopeCheck. The protectedApprovalOk TypeScript copy and its fixture are removed.", "deferred_to": ""},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "The plan separates existing code (mergeDecision signature at land-guard.mjs:108; protectedTouched call at :284) from new code (protectedApproval construction, front-matter parsing, seat derivation through seatOf(), validatePlan extension).", "deferred_to": ""}
]
```
