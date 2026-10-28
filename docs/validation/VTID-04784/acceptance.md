# VTID-04784 — memory plan phase 2: compare the ORB memory read paths on real sessions

Production voice reads memory through the legacy six-table read; staging through recall() (VTID-04452). The plan (§8.4 phase 2) flips production only after comparing both on real sessions; staging has too few.

With `MEMORY_ORB_RECALL_SHADOW=true` (pinned on staging and production):
- the bridge serves the path it serves today;
- it reads the other path in the background, never awaited and never throwing;
- it logs one counts-only line per session. The line never contains a fact key, a value or any member text.

`scripts/memory/recall-shadow-report.sh` summarises the lines from CloudWatch (read-only).

## Acceptance

AC-1: the comparison counts shared, one-sided and differing facts, ai_memory rows, other items, prompt size and latency.
TEST: services/gateway/test/services/memory/vtid-04784-recall-shadow.test.ts

AC-2: the log line carries counts only, never a key, value or member text.
TEST: services/gateway/test/services/memory/vtid-04784-recall-shadow.test.ts

AC-3: the served answer is unchanged, the shadow runs once and only for an ok read with an identity, and a failing shadow read never throws.
TEST: services/gateway/test/services/memory/vtid-04784-recall-shadow.test.ts

AC-4: the flag is pinned on both gateways, and the generated pins file is current.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts
