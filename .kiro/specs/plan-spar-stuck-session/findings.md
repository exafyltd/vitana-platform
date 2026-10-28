# Findings — stuck PLAN-SPAR session (2026-10-27), for the pipeline-speed analysis

Recorded for any session analysing pipeline speed; this plan edits no pipeline-speed file.

| Time (UTC) | Event |
|---|---|
| 10:55 | `plan(kiro-web-reliability)` #4392 opened; PLAN-SPAR run 40492189091 attempt 1 creates session `087401c4-…` (~10:59) |
| 11:27 | attempt 1 fails: `no round 1 after 25 min` |
| 11:38 | re-run (attempt 2, §7a infra allowlist) posts the same body; the row is 40 min old < `STALE_AFTER_MS` 60 min → deduplicated onto the stuck session |
| 12:04 | attempt 2 fails the same way |
| 12:06 | a changed plan text (new hash) creates session `52ba3de1-…`; round 1 at ~12:22 (16 min) |

Cost of the incident: ~70 min of wall clock for one plan, two runner-hours, and an extra plan revision to escape the
dedup. Cause classes that leave a 0-round session (code read, not logs): the round-1 pass runs synchronously in the
create request, a model call has no timeout (deadline checked only between turns), a replaced gateway task or a
`store_error` after the pass. The gateway logs for `087401c4` were not read (no live-system access from the session),
so which of these happened is unconfirmed.

With `proposed.patch`: the hang ends at the 15-min pass deadline as an escalated, retryable round 1; and the client's
single re-post after its 25-min wait gets a fresh session (20-min stale window), inside the same run. Expected worst
case for this incident: ~25-40 min instead of ~70 min plus a manual plan edit.

Splitting `kiro-web-reliability` was considered and not done: round 1 had already arrived; a split adds one more
plan, one more sparring session (≥ 15 min each) and one more plan merge, and both lanes already build in parallel.
