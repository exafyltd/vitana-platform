# Responses to sparring round 1
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: the deadline is checked only at the top of each turn (partner.ts:174) and the call itself is unbounded, because the Bedrock adapter sends InvokeModelCommand through a default NodeHttpHandler with no request timeout (services/gateway/src/providers/bedrock.ts:218-229). The row has no liveness signal during a pass: model_log is written only after runPartnerPass returns (plan-sparring-service.ts:294,301), and rounds/updated_at change only in writeRound (:222-236). So model_log presence (suggestion b) cannot tell live from dead, and the plan takes the larger-margin route instead. The class-based deadline + 10 min threshold is replaced by a flat STALE_AFTER_MS = 60 min for every class, which leaves 45 min past the longest deadline (standard, 15 min, :44) for one in-flight call. The five stuck rows are hours old, so they still recover. The cost is recorded: a newly dead session recovers on the first push 60 min or more after creation, and a push before that times out after WAIT_MS exactly as today (plan-spar.mjs:37). Per suggestion (c), the residual trade-off is now written into plan item 1: if a live pass still runs past 60 min, the new session wins, the old pass's writeRound gets 409 round_conflict from the append RPC's in_progress check (:228-232), one partner pass is wasted, and no plan is terminalized and no session budget is used (deadline_exceeded is infra + retryable, plan-spar.mjs:34-35). Updated plan.md item 1 and test (f), design.md Threshold, and tasks.md S2.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: if escalateDeadRoundOne succeeds and insertSession then fails (:255-265 throws 502 store_error), the old row is left escalated + deadline_exceeded with final_plan_hash null and no successor. It recovers on the next create through the existing retryable branch (:250-252: no human_approved_by, verdict escalated, deadline_exceeded in RETRYABLE_REASONS :46). The plan now states this dependency explicitly instead of calling that branch merely 'unchanged', and adds test (h): escalation succeeds, insert returns an error, the call throws 502, and the next create with the same plan inserts a fresh session and runs round 1 (deduplicated: false). tasks.md S2 forbids touching RETRYABLE_REASONS, S3 adds a one-shot insertSession error switch to the mock, and the Overlap section tells sparring-floor-retry to keep deadline_exceeded retryable. Insert-before-escalate is not adopted: the guarded UPDATE is what decides a race between two creates, and inserting first would let both racers insert a session. That reasoning is recorded in plan item 1 and design.md.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "rejected",
    "rationale": "Both files exist at the plan's base. services/gateway/test/vtid-04868-plan-sparring-service.test.ts has 989 lines; its repository mock starts at :31 (jest.mock('../src/services/plan-sparring/plan-sparring-repository', ...)) and closes at :112, and makeDeps is at :209-236. services/gateway/test/vtid-04868-plan-sparring-repository.test.ts has 116 lines. The same directory also holds vtid-04868-plan-sparring-migration, -session-layer and -stage test files. The partner's listing was truncated before the v prefix, so it did not reach them. The verification command is unchanged. Plan item 3 now names both suites by full path, with their line anchors, so the reference cannot be misread.",
    "deferred_to": null
  }
]
```
