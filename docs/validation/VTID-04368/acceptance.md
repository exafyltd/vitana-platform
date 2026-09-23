# VTID-04368 — Acceptance

## Context

Live, 2026-09-22 22:00 → 2026-09-23 11:27 UTC (read-only queries, `outputs/live-evidence.md`):
the AWS account block made every Bedrock call fail with `Operation not allowed`
and DeepSeek returned 402 `Insufficient Balance`, so every Dev Autopilot
execution died on its first LLM call (~36 per hour). One impact finding,
`b560c306` (rule `new-env-var-requires-workflow-binding`), was re-executed
**461 times in 12.5 hours**. Cause: the IMPACT auto-approve pass had no retry
cap and no turn-cap snooze (the baseline pass had both). The baseline cap
would have made it worse in another way: it counted outage failures against
each finding and would have snoozed every finding for 7 days over an outage
that had nothing to do with them.

## Acceptance Criteria

AC-1: The live Bedrock-block and DeepSeek-402 failure shapes are recognised as provider outages; a finding's own failures (turn cap, tsc) are not.
TEST: services/gateway/test/vtid-04368-retry-storm-outage-gate.test.ts — "matches the live Bedrock-block and DeepSeek-402 shapes", "does not match a failure that is the finding's own"

AC-2: Outage failures never count toward a finding's retry cap; real failures still snooze at the cap; one turn-cap failure still snoozes.
TEST: services/gateway/test/vtid-04368-retry-storm-outage-gate.test.ts — "461 outage failures never snooze a finding", "snoozes at the cap on real failures, outages excluded from the count", "one turn-cap failure snoozes (VTID-04243 behaviour kept)"

AC-3: The impact pass and the baseline pass run the same breaker.
TEST: services/gateway/test/vtid-04368-retry-storm-outage-gate.test.ts — "the impact pass runs the retry breaker before approving", "the baseline pass uses the same breaker (no second copy of the cap)"
TEST: services/gateway/test/vtid-04243-turn-cap-breaker.test.ts — "reads metadata on the terminal-failure rows and decides with the breaker", "snoozes the finding 7 days, emits an OASIS event, and refuses the approval"

AC-4: While the newest three terminal failures are outages inside 30 minutes, nothing is approved or claimed; outside the window the loop probes with one execution; a real failure clears it.
TEST: services/gateway/test/vtid-04368-retry-storm-outage-gate.test.ts — "outage: the newest three are outage failures and recent", "probe: newest is an outage but outside the window, or the streak is short", "clear: newest failure is a real one, or there are none", "slots: none during an outage, one while probing, unchanged when clear", "approval and claiming both go through the outage gate"

AC-5: The supervisor snapshot reports `provider_outage` and raises a critical alert naming the provider error.
TEST: services/gateway/test/vtid-04368-retry-storm-outage-gate.test.ts — "is critical during an outage and names the provider error", "is absent when clear"

AC-6 (post-deploy, live): during the next provider outage, `dev_autopilot.provider_outage.detected` appears once in `oasis_events`, executions per hour drop from ~36 to at most ~2 probes, and no finding is snoozed for it.
CURL: curl -s https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/supervisor
