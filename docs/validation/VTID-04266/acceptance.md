# VTID-04266 — Autonomy Pulse surfaces awaiting_approval executions

## Report

Part of the Command Hub Autopilot supervisor-visibility task list named in
VTID-04262's CHANGE LOG row. Autonomy Pulse's own header comment describes
it as "a single pane of glass so the supervisor never has to correlate
across GitHub, Cloud Run, Supabase, OASIS, Self-Healing, and Dev Autopilot
screens separately." Confirmed by reading `services/gateway/src/routes/
autonomy-pulse.ts` directly: `fetchExecutions`'s query
(`status=in.(cooling,running,ci,merging,deploying,verifying)`) and the
`/pulse/counts` badge query both excluded `awaiting_approval` —
`dev_autopilot_executions` rows where the agent pushed a branch and is
holding for a human decision (VTID-04029). That is precisely the status
most in need of an operator's attention, and it was invisible on the one
screen built to surface exactly that.

Implemented directly by this Claude Code session, continuing the "when
Operator fails, Claude Code takes over" task list started with VTID-04264.

## Acceptance Criteria

AC-1 — Both `fetchExecutions` (the `/pulse` feed) and the `/pulse/counts`
badge query include `awaiting_approval` alongside the existing active
statuses.
TEST: services/gateway/test/autonomy-pulse.test.ts — "fetchExecutions (the /pulse feed) queries awaiting_approval alongside the other active statuses".

AC-2 — An `awaiting_approval` execution normalizes to `severity: 'critical'`
(it is blocked on a human, not on anything autonomous, so it outranks the
depth-based warning/info split every other status uses — including for a
self-heal child with `auto_fix_depth > 0`).
TEST: services/gateway/test/autonomy-pulse.test.ts — "an awaiting_approval execution surfaces as critical with approve/reject actions" and "an awaiting_approval execution is critical even for a depth>0 self-heal child (the human decision outranks the depth-based warning)".

AC-3 — An `awaiting_approval` execution's `actions` are `['approve',
'reject', 'view_trace']`, not the `cancel`/`view_trace` set every other
active status gets.
TEST: services/gateway/test/autonomy-pulse.test.ts — "an awaiting_approval execution surfaces as critical with approve/reject actions".

AC-4 — On the Command Hub side, clicking Approve/Reject on an
`autonomous_execution` Pulse item calls the SAME routes the Autopilot Live
and Dev Autopilot cards already use
(`POST /api/v1/dev-autopilot/executions/:id/approve` /
`.../reject`) — no new backend logic duplicated.
TEST: services/gateway/test/vtid-04266-autonomy-pulse-awaiting-approval.test.ts — "an approve action on an autonomous_execution item calls the same route the Live/Dev Autopilot cards use" and "a reject action on an autonomous_execution item calls the same route the Live/Dev Autopilot cards use".

AC-5 — The pre-existing `cancel` action for a `cooling` execution is
unmodified by this change.
TEST: services/gateway/test/vtid-04266-autonomy-pulse-awaiting-approval.test.ts — "the existing cancel action for autonomous_execution is untouched" (also: services/gateway/test/autonomy-pulse.test.ts's pre-existing "normalizes active executions and only offers cancel during cooldown" re-run green, unmodified expectations).

AC-6 — The Command Hub's cache-bust marker on `index.html` is bumped for
both `app.js` and `styles.css` (identical marker string), per CLAUDE.md §16
IF-THEN 25.
TEST: services/gateway/test/vtid-04266-autonomy-pulse-awaiting-approval.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted by the pre-existing services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts).

AC-7 — `scripts/ci/command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN`
recognizes this VTID (branch
`claude/vtid-04266-autonomy-pulse-awaiting-approval`, PR title carrying
`VTID-04266`).
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts — full file (pre-existing, generic pin — re-run green after the allowlist addition; also verified directly, see commands.log).

## OASIS Impact

No new mutation route, no new OASIS event topic, no schema change.
Approve/reject on an `awaiting_approval` execution from Autonomy Pulse
routes through the exact same pre-existing `POST /executions/:id/approve`
/ `.../reject` handlers (VTID-04029) the Autopilot Live and Dev Autopilot
cards already call — unmodified by this change.
