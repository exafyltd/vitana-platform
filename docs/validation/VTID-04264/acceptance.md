# VTID-04264 — Dev Autopilot kill-switch button on Command Hub

## Report

Part of the Command Hub Autopilot supervisor-visibility task list named in
VTID-04262's CHANGE LOG row (kill-switch button, tool-call transcript on
Autopilot Live, `awaiting_approval` visibility in Autonomy Pulse, cost
surfacing). `services/gateway/src/routes/dev-autopilot.ts` already had a
fully-working `GET /api/v1/dev-autopilot/config` /
`POST /api/v1/dev-autopilot/config/kill-switch` pair — the Command Hub Dev
Autopilot panel only ever displayed `cfg.kill_switch` as a read-only chip
(`renderDevAutopilotView`), with no control to actually flip it. Arming or
disarming the switch required a direct DB write.

This task was first queued into the Operator Console via `autopilot_run_task`
(self-allocated this same VTID) and exhausted its 120-turn agent cap purely
navigating the 2.6MB `app.js` file — confirmed via `dev_query_oasis_events`:
turns spent entirely on `read_file`/`search_text`, zero `write_file`/
`edit_file` calls, one single LLM call measured at ~603s while reading
`app.js`. Implemented directly by this Claude Code session per the standing
"when Operator fails, Claude Code takes over" instruction.

## Acceptance Criteria

AC-1 — The Dev Autopilot panel header shows a toggle button next to Refresh
that reads the switch's current state from the same `GET /config` response
already powering the read-only chip (no new fetch introduced for this).
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "derives the armed state from the existing GET /config response, not a new fetch".

AC-2 — Clicking the button calls the existing, unmodified
`POST /api/v1/dev-autopilot/config/kill-switch` route with `{ armed }`,
using the same `buildContextHeaders` auth pattern every other admin-gated
Command Hub call uses.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "calls the existing POST /api/v1/dev-autopilot/config/kill-switch route with { armed }" and "sends the same auth headers every other admin-gated Command Hub call uses (buildContextHeaders)".

AC-3 — Arming the switch (a disruptive action — blocks new executions) asks
for confirmation first; disarming does not.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "confirms before ARMING (a real, disruptive action) but not before disarming".

AC-4 — After a successful toggle, the panel re-fetches Dev Autopilot state
so the button label and the pre-existing read-only status-strip chip agree.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "re-fetches Dev Autopilot state after a successful toggle so the button and the read-only chip stay in sync".

AC-5 — A failed toggle (network error or `{ ok: false }`) surfaces via the
existing `showToast` mechanism instead of failing silently.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "surfaces a failed toggle via showToast rather than failing silently".

AC-6 — No new inline `.style.cssText` (the CSP Governance Gate flags any
`\.style\b` hit in an ADDED line) — button spacing comes from a small
dedicated CSS class instead, colors/sizing from the pre-existing
`.btn`/`.btn-success`/`.btn-danger` classes.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — full file (no `.style.cssText` assertion needed; verified directly against the CSP gate itself, see commands.log).

AC-7 — The Command Hub's cache-bust marker on `index.html` is bumped for
both `app.js` and `styles.css` (identical marker string), per CLAUDE.md §16
IF-THEN 25 and the pre-existing cache-bust pin test.
TEST: services/gateway/test/vtid-04264-kill-switch-button.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted by the pre-existing services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts).

AC-8 — `scripts/ci/command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN`
recognizes this VTID (branch `claude/vtid-04264-kill-switch-button`, PR
title carrying `VTID-04264`) so the Command Hub path-ownership guard does
not block this PR.
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts — full file (pre-existing, generic pin — re-run green after the allowlist addition; also verified directly, see commands.log).

## OASIS Impact

No new mutation route, no new OASIS event topic. `POST /config/kill-switch`
already emits `dev_autopilot.kill_switch.activated`/`.deactivated` —
unmodified by this change.
