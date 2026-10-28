# VTID-04399 — Conversation rebuild WS-1.2: pre-computed core context snapshot per user

Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.2.
Ships in PR #3614 as a companion to VTID-04339.

## What was wrong (measured, read-only, 7 days to 2026-09-23)

- **The context wait usually runs out.** The voice session's context build
  (`buildBrainSystemInstruction`: memory, calendar, OASIS, Life Compass,
  identity, proactive guide) takes seconds. The stream-open gate waits
  `ORB_CONTEXT_READY_GATE_TIMEOUT_MS`, which is 300 ms on both stacks. It
  timed out on 162 of 177 turn-0 waits (91.5%).
- **A third of signed-in sessions ran with no memory context at all.**
  Signed-in sessions were matched by joining `voice.latency.measured` turn-0
  rows to `vtid.live.session.start`. In 53 of 158 of them, the final upstream
  setup carried `context_chars = 0`. The rollup below reproduces this as
  52 of 157.
  - Nothing adds the late context to a session that is already connected.
    Only a later transparent reconnect rebuilds it.
  - So those conversations ran without the user's name, memory or goal, for
    the whole session.
- **The plan's premise was wrong.** Plan v1 describes this as "start empty,
  then reconnect". There is no code path that reconnects to upgrade the
  context (`reconnect_triggered` shows 3 events in 7 days, all
  `stall_recovery`). Empty sessions simply stay empty, so there is no
  reconnect path to put behind a flag.

## Fix

- **What the snapshot is.** `brain_core_snapshot_v1` is one
  `user_assistant_state` row per user, holding:
  - the stable part of the brain instruction: everything before the
    time-bound proactive guide block (identity, memory, Life Compass goal,
    general rules);
  - when it was built, a content hash, and the language.

  Community role only, so a Command Hub build never overwrites it.
- **`vitana-brain.ts`.** `buildBrainSystemInstruction` now also returns
  `coreInstruction`. The full `instruction` is still
  `` `${coreInstruction}\n${proactiveGuideBlock}` ``, byte-identical to
  before.
- **Read.** The controller reads the row in parallel with the fresh build:
  one indexed read, fail-open, bounded at 1.5 s.
- **Gate.** After the fresh-context race, if the session is still empty, the
  gate waits up to 150 ms more for the snapshot read
  (`BRAIN_CORE_SNAPSHOT_GATE_WAIT_MS`), then uses it:
  - The text gets a dated header telling the model that date-relative items
    are as of the snapshot time.
  - A context the fresh build already wrote is never replaced.
  - The fresh build still overwrites the session context when it lands, as
    before.
  - A snapshot older than 72 h (`BRAIN_CORE_SNAPSHOT_MAX_AGE_HOURS`) is not
    used.
- **Write-through.** After every fresh build the snapshot is written,
  throttled against the row this session already read:
  - write when the row is absent, older than 6 h, or changed and at least
    10 min old;
  - skip when it is unchanged or changed less than 10 min ago.
- **Refresh after a session ends.** `finalizeLiveSession` schedules a
  rebuild 90 s later (`BRAIN_CORE_SNAPSHOT_REFRESH_DELAY_MS`), debounced per
  user. That way the facts the session's memory commit extracted are in the
  next session's snapshot even when that session's own build is slow.
- **Telemetry.**
  - The `context_awaited` and `setup_sent` latency marks carry
    `context_source` (fresh / snapshot / none).
  - New diag `core_snapshot_used`.
- **Metrics.**
  - The rollup (`conversation_metrics_rollup_hour`, migration
    `20260923160000`, applied live) gains `context_setup_empty`,
    `context_setup_source` and `diag_core_snapshot_used`. The 168-hour
    history was re-rolled.
  - The summary API exposes `speed.context_setup_empty`,
    `speed.context_sources` and `speed.core_snapshot_used`.
  - Conversation → Monitor shows "Started with no context" (target < 5%) and
    "Context source".
- **Kill switch.** `BRAIN_CORE_SNAPSHOT=false` turns off read, write and
  refresh.

## Found and fixed on the way (VTID-04371 regression, same PR)

- When `origin/main` was merged into this branch (`ffb656eca`), the
  VTID-04371 `.conv-metric-*` rules landed inside `main`'s new `.orch-*`
  `@media (max-width: 600px)` block, whose closing brace ended up after them.
- As a result the Monitor and Learning dashboards were styled on phones only;
  on desktop they rendered as raw text (see the first desktop capture in
  `commands.log`).
- The fix is one `}` in the right place. A new test fails if any metric rule
  is nested inside another block; it was mutation-checked by running it
  against the pre-fix file, where it fails naming `@media (max-width: 600px)`.

## Acceptance criteria

AC-1: The snapshot value is built from the core instruction only, bounded at a line break, validated on read, and rejected when absent, older than 72 h or future-dated.
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-2: The read is one row by signal name, fails open to null on an error, a hang or the kill switch; the write-through is throttled against the row the session already read.
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-3: The gate fallback never replaces a fresh context, fills an empty session from the snapshot, bounds its wait, and lets a fresh build that lands during the wait win.
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-4: Session end schedules one debounced community-only refresh after the summary and continuity writes; a scheduling failure never breaks finalize.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts, services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-5: The brain's full instruction is byte-identical (core + proactive guide); the controller, gate and latency marks are wired as described (source contracts).
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-6: The rollup computes the empty-context rate and context sources (applied live; the 7-day baseline reads 52 of 157, source unknown), and the summary exposes them.
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-7: Conversation → Monitor shows the two new tiles at 1400×900 and 390×844 with no page errors or horizontal overflow, and the metric styles apply on desktop again.
UI: docs/validation/VTID-04399/outputs/monitor-desktop.png, docs/validation/VTID-04399/outputs/monitor-mobile.png, docs/validation/VTID-04399/outputs/shoot-report.json

AC-8: No regression in the conversation, Command Hub, ORB session, route and guard suites; tsc clean; CSP gate clean.
TEST: services/gateway/test/services/conversation, services/gateway/test/command-hub, services/gateway/test/orb/live/session, services/gateway/test/scripts

AC-9 (post-deploy, staging): after a signed-in staging session ends, a `brain_core_snapshot_v1` row exists for that user; on the next session whose fresh build misses the gate, `orb.live.diag` shows `stage=core_snapshot_used` and `setup_sent.context_source = 'snapshot'`; the Monitor's "Started with no context" falls toward < 5% as new sessions accrue.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/metrics/summary

## Not verified live

- Not deployed. No staging session has read or written a snapshot yet
  (AC-9).
- The first real signals will be:
  - a `brain_core_snapshot_v1` row appearing;
  - `core_snapshot_used` diags;
  - `context_setup_source` rows with `source:snapshot`.
- The refresh runs in-process. A deploy or scale-in inside the 90 s delay
  loses that one refresh; the next session's write-through repairs it.
- Not built here, as the plan's other refresh triggers: individual fact
  writes, goal changes, and a nightly job. A nightly job needs an
  EventBridge schedule the owner runs.
