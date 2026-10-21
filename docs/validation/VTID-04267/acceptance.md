# VTID-04267 — Dev Autopilot spend surfaced in Command Hub

## Report

Part of the Command Hub Autopilot supervisor-visibility task list named in
VTID-04262's CHANGE LOG row. The Dev Autopilot panel's status strip showed
a "Budget: —/N today" chip that never resolved past the dash. Confirmed by
reading the code: that chip is the daily APPROVAL-COUNT budget
(`dev_autopilot_config.daily_budget`, a count, not dollars —
`dev-autopilot-safety.ts`'s `daily_budget_exhausted` gate) and the
approved-count half was never fetched by this view at all. No real dollar
spend figure existed anywhere in the Command Hub, even though the per-run
cost has been recorded since VTID-04017
(`dev_autopilot_outcomes.metadata.agent_runs[].cost_usd`).

`dev_autopilot_outcomes` has no `updated_at` column — a PATCH that appends
a run doesn't touch `created_at` — so "today's spend" can't be a
server-side date-filtered query; a new pure `summarizeSpendToday()` sums
whichever `agent_runs[]` entries carry a `recorded_at` from today (UTC)
across a bounded recent window of rows, behind a new
`GET /api/v1/dev-autopilot/spend` route.

Implemented directly by this Claude Code session, continuing the "when
Operator fails, Claude Code takes over" task list started with VTID-04264.

## Acceptance Criteria

AC-1 — `summarizeSpendToday` sums `cost_usd`/`input_tokens`/`output_tokens`
across every `agent_runs[]` entry (from any row, any number of entries per
row) whose `recorded_at` falls within the current UTC day, and counts
`runs_today`.
TEST: services/gateway/test/services/dev-autopilot-outcomes.test.ts — "sums cost_usd and tokens across agent_runs[] recorded today, across multiple rows" and "sums multiple runs on the SAME outcome row (agent_runs[] can hold several entries)".

AC-2 — Runs recorded before the start of the current UTC day are excluded.
TEST: services/gateway/test/services/dev-autopilot-outcomes.test.ts — "excludes runs recorded before the start of the current UTC day".

AC-3 — `summarizeSpendToday` never throws on malformed/missing metadata
(null, non-object, non-array `agent_runs`, malformed entries) and returns
all zeros for an empty input.
TEST: services/gateway/test/services/dev-autopilot-outcomes.test.ts — "returns all zeros for an empty input, and never throws on malformed metadata".

AC-4 — `GET /api/v1/dev-autopilot/spend` is gated by the same `requireDevRole`
governance gate as every other Dev Autopilot endpoint (401 unauthenticated,
403 non-admin), queries a bounded, ordered window of
`dev_autopilot_outcomes` rows (never an unbounded scan), and passes
`summarizeSpendToday`'s result straight through.
TEST: services/gateway/test/routes/dev-autopilot.test.ts — the `requireDevRole governance gate` `it.each` suite (now covering `GET /spend`) plus the new `GET /spend` describe block ("sums agent_runs[] recorded today across the fetched outcome rows", "returns all zeros, not an error, when there are no outcome rows yet", "returns 500 when the Supabase query itself fails", "queries only recent rows (bounded, ordered) — no unbounded table scan").

AC-5 — The Command Hub Dev Autopilot panel fetches `GET /spend` alongside
its other panel data (runs/queue/config/executions) and renders a real
"Spend today" chip — degrading to an honest dash, never a fabricated
number, when the fetch hasn't resolved or failed.
TEST: services/gateway/test/vtid-04267-dev-autopilot-spend.test.ts — "fetchDevAutopilotState fetches GET /api/v1/dev-autopilot/spend alongside the other panel data", "a failed/errored spend fetch degrades to null, never throwing or blocking the rest of the panel", "renders a real \"Spend today\" chip using the fetched figure, not a hardcoded dash".

AC-6 — The Spend chip discloses the same list-price/estimate caveat
(`TURN_COST_ESTIMATE_NOTE`) already used by the Operator Console's own
turn-cost badge (VTID-04031), so the figure isn't read as an exact bill.
TEST: services/gateway/test/vtid-04267-dev-autopilot-spend.test.ts — "the Spend chip discloses the same list-price/estimate caveat the Operator Console turn-cost badge already uses".

AC-7 — The pre-existing (still fake, out of scope for this VTID) "Budget"
chip is untouched.
TEST: services/gateway/test/vtid-04267-dev-autopilot-spend.test.ts — "the pre-existing (still fake) Budget chip is untouched by this change".

AC-8 — The Command Hub's cache-bust marker on `index.html` is bumped for
both `app.js` and `styles.css` (identical marker string), per CLAUDE.md §16
IF-THEN 25.
TEST: services/gateway/test/vtid-04267-dev-autopilot-spend.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted by the pre-existing services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts).

AC-9 — `scripts/ci/command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN`
recognizes this VTID (branch `claude/vtid-04267-dev-autopilot-spend`, PR
title carrying `VTID-04267`).
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts — full file (pre-existing, generic pin — re-run green after the allowlist addition; also verified directly, see commands.log).

## Route evidence

`GET /api/v1/dev-autopilot/spend` is a new route on the existing
`/api/v1/dev-autopilot` router (`services/gateway/src/routes/dev-autopilot.ts`,
mounted at `services/gateway/src/index.ts` alongside every other
`dev-autopilot` route — mount point unchanged by this PR).

ROUTE_MOUNT: `router.get('/spend', requireDevRole, ...)` in
`services/gateway/src/routes/dev-autopilot.ts`, on the pre-existing
`/api/v1/dev-autopilot` router.
FINAL_URL: `GET /api/v1/dev-autopilot/spend`
CURL_PROOF: not run against a live deployment from this session (no
staging bearer token / exafy_admin session available here); the route's
shape (401 unauthenticated, 403 non-admin, 200 with a real
`summarizeSpendToday` result, 500 on a Supabase query failure, bounded/
ordered query — never an unbounded scan) is exercised in full by the jest
suite listed under AC-4, which drives the real Express router with a
mocked `fetch` — the same pattern this file's sibling `GET /config` route
is tested with.

## OASIS Impact

No OASIS event topic, no schema change. `GET /spend` is a new, purely
read-only endpoint over the existing `dev_autopilot_outcomes` table.
