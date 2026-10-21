# VTID-04265 — Autopilot Live step/tool-call transcript

## Report

Part of the Command Hub Autopilot supervisor-visibility task list named in
VTID-04262's CHANGE LOG row. The Autopilot Live view's Dev Autopilot
execution cards showed only a status pill (queued/running/ci/…) — an
operator watching a running agent had no way to see its steps without
leaving the page for the Operator Console chat panel, which already has
this exact transcript (VTID-04033: `followOperatorExecution`,
`state.operatorExecFollow`, `describeFollowedStep`).

Implemented directly by this Claude Code session, continuing the "when
Operator fails, Claude Code takes over" task list started with VTID-04264.

## Acceptance Criteria

AC-1 — Every Dev Autopilot execution card on Autopilot Live gets a
"▸ Steps" / "▾ Steps" toggle, available regardless of status (not only
`awaiting_approval`, unlike the pre-existing Diff toggle) — an operator can
watch a still-running agent, not just review a finished one.
TEST: services/gateway/test/vtid-04265-live-steps-transcript.test.ts — "renders a Steps toggle button on every Dev Autopilot execution card, not only awaiting_approval".

AC-2 — Opening the toggle starts the SAME SSE connection
(`followOperatorExecution` → `GET /executions/:id/stream`) the Operator
Console chat panel already uses — no second transport implementation.
Closing it tears the connection down via the existing
`closeOperatorExecutionFollow`; a re-open replays full history from the
start (the stream's own documented behaviour), so nothing is lost.
TEST: services/gateway/test/vtid-04265-live-steps-transcript.test.ts — "the toggle opens/closes the followOperatorExecution SSE stream rather than a new one".

AC-3 — The transcript panel reads from the same `state.operatorExecFollow`
bucket the Operator Console writes to, and reuses `describeFollowedStep`
for per-step line text — one source of truth for both surfaces.
TEST: services/gateway/test/vtid-04265-live-steps-transcript.test.ts — "the panel reads from the SAME state.operatorExecFollow bucket the Operator Console chat panel writes to" and "reuses describeFollowedStep for the per-step line text instead of a second formatter".

AC-4 — No new CSS/inline styling: the panel reuses the pre-existing
`chat-exec-follow`/`chat-tool-activity-line` classes already shipped for
the Operator Console panel, and introduces no `.style.cssText` (the CSP
Governance Gate's `\.style\b` check).
TEST: services/gateway/test/vtid-04265-live-steps-transcript.test.ts — "reuses the pre-existing chat-exec-follow / chat-tool-activity-line CSS classes — no new styling introduced" (also verified directly against the CSP gate, see commands.log).

AC-5 — The Command Hub's cache-bust marker on `index.html` is bumped for
both `app.js` and `styles.css` (identical marker string), per CLAUDE.md §16
IF-THEN 25.
TEST: services/gateway/test/vtid-04265-live-steps-transcript.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted by the pre-existing services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts).

AC-6 — `scripts/ci/command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN`
recognizes this VTID (branch `claude/vtid-04265-live-steps-transcript`, PR
title carrying `VTID-04265`).
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts — full file (pre-existing, generic pin — re-run green after the allowlist addition; also verified directly, see commands.log).

## OASIS Impact

No new mutation route, no new OASIS event topic, no schema change. The
panel is purely a client-side consumer of the existing
`GET /executions/:id/stream` SSE endpoint (VTID-03897), unmodified by this
change.
