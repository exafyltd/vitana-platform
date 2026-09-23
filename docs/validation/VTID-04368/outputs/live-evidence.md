# Live evidence (read-only, 2026-09-23 ~13:45 UTC)

Terminal executions, last 10 days, top reasons:
- failed_escalated — "both providers failed: primary=Bedrock invoke_failed: Operation not allowed" — 325 (+14 +2 +1 variants)
- failed_escalated — "both providers failed: primary=DeepSeek 402 … Insufficient Balance" — 136 (+2 +1)
- failed — "agent hit the 120-turn cap without calling finish" — 57

Per hour: 0 outage failures before 2026-09-22 22:00 UTC, 30–39 per hour from 22:00 until 11:00 on 09-23, none after the kill switch was armed at 11:27.

Per finding (outage failures, last 20 h): b560c306 (dev_autopilot_impact, rule new-env-var-requires-workflow-binding, status still `new`) — 461 executions, 22:48 → 11:24, claimed by both production and staging. Six baseline findings: 2–5 each, then snoozed by the old cap.
