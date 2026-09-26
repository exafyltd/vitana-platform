# Dev Autopilot recommendations — quality analysis and plan (VTID-04657)

Status: analysis done 2026-09-26 from the code and live data (read-only).
The Activate fix ships in the same PR; everything under "Plan" is proposed.

## 1. What the scores mean today

No recommendation is scored by judgement. Every `impact_score` / `effort_score`
is a constant or a three-step lookup:

| Source | Signal | Impact | Effort | Where |
|---|---|---|---|---|
| `oasis` | ≥10 `status=error` events of one topic in 24 h | always 8 | 5 | `recommendation-generator.ts:242`, `signal-impact.ts` |
| `roadmap` | VTID not updated for 14+ days | 8 if >60 days, else 6 | 5 | `recommendation-generator.ts:287` |
| `health` | env var missing from the gateway process | 8 | 4 | `health-analyzer.ts:244` |
| `behavior` | activation / conversation counts | 4–7 by type | 4 | `recommendation-generator.ts:398` |
| `dev_autopilot` | scanner severity low/medium/high | 3 / 6 / 8 | per type (todo 3, large file 7, safety gap 6, CVE 2) | `dev-autopilot-synthesis.ts:152` |
| `dev_autopilot_impact` | diff rule | 8 blocker, else 5 | 3 | `routes/dev-autopilot.ts:294` |
| `operator_onramp` | operator request | 5 | 4 | `operator-execution-onramp.ts:339` |

"Impact 6/10" on the Pending Approvals card therefore means "the scanner
called it medium severity", nothing more. Nothing ranks across sources, nothing
estimates cost or chance of success, and `seen_count` is unused.

## 2. What the output has been worth (live, all time unless noted)

| Source | Shipped | Rejected / archived | Notes |
|---|---|---|---|
| `dev_autopilot` | 15 completed | 170 rejected + 902 auto-archived | |
| `dev_autopilot_impact` | 4 | 391 rejected | |
| `oasis` | 0 | 64 rejected | 15 open |
| `roadmap` | 0 (1 activated) | 44 rejected | 10 open |
| `behavior` | 0 | 63 rejected | 8 open |
| `health` | 0 | 8 rejected | 2 open, both permanent false positives |

Executions in the last 30 days, by scanner: todo, safety-gap, npm-audit,
missing-tests, schema-drift, route-auth, stale-flag, dead-code — **74
executions, 0 completed**. One impact rule
(`new-env-var-requires-workflow-binding`) ran **467 executions for a single
finding** during the 22–23 Sept provider outage.

Token cost, last 30 days: the agent executor made 13,063 calls with **641 M
input tokens**; the planner 385 calls / 19 M. Almost none of it produced a
merged change from a scanner finding.

Noise visible in today's open list:

- `roadmap`: "Unblock VTID-01057 … stalled in voided — no activity for 9765
  days". The query only excludes `completed`/`archived`, so voided, deleted,
  rejected and terminal VTIDs are recommended, oldest first, with no date sanity check.
- `oasis`: `voice.latency.measured` is latency telemetry emitted with
  `status:'error'`, reported as a "recurring error". One provider outage
  appears as 4 separate cards (`llm.call.failed` per service). The verification
  noise filter that already exists (`isVerificationNoiseTopic`) is not used here.
- `health`: "Configure `ANTHROPIC_API_KEY`" and "`GITHUB_TOKEN`". The first
  is deliberately unset (standing Bedrock rule); the gateway uses
  `GITHUB_SAFE_MERGE_TOKEN`. Both fire forever.
- `operator_onramp`: 103 rows sit in `status='new'` although each one already
  belongs to an operator-executed VTID.
- Dedupe only blocks a fingerprint while the old row is `new`/`snoozed`, so a
  rejected or expired signal comes back on the next run. `dev_autopilot` rows
  never expire.
- The popup sorts `risk_class.desc` as text (medium > low > high), so
  high-risk rows come last.

## 3. Activate (fixed in this PR)

Tested against the real code and live data: **the last 6 Activate clicks
created 0 executions**. The RPC marks the finding `activated`, then the
executor's approval refused anything not `new`, and the route reported
success anyway. `oasis` / `roadmap` / `behavior` have no executor at all, so
Activate on them only ever produced a VTID and a TBD spec. Details and tests:
`docs/validation/VTID-04657/`.

## 4. Plan

Principle: a card reaches a human only if it names a concrete defect with
evidence, says what fixing it is worth, and the system can estimate what it
will cost and whether it will succeed. Deterministic filters first, model
calls last and only on survivors.

### P1 — Remove the noise (deterministic, no model cost)

1. `roadmap`: exclude `is_terminal`, voided / deleted / rejected / cancelled
   VTIDs; only recommend work someone approved (`spec_status='approved'`);
   cap and sanity-check age.
2. `oasis`: apply `isVerificationNoiseTopic`; stop emitting
   `voice.latency.measured` as `status:'error'`; cluster by root cause
   (provider + error class), not by service, so one outage is one card; skip a
   cluster whose root cause already has an open card or an open incident.
3. `health`: read an "intentionally absent" list (decision_policy) —
   `ANTHROPIC_API_KEY` goes there; check `GITHUB_SAFE_MERGE_TOKEN`, not
   `GITHUB_TOKEN`.
4. `operator_onramp` rows leave `new` when their execution is created; they are
   not recommendations.
5. Rejected fingerprints stay blocked for 30 days on every source; every source
   gets an expiry; `seen_count` feeds "recurring" instead of re-inserting.
6. Fix the popup sort (explicit risk rank, then priority).

### P2 — Real scoring instead of constants

Store the components and show them instead of "6/10":

- **Value** — who is affected (members, operators, CI only), how badly (outage,
  wrong data, cosmetic), how often and whether it is growing (from
  `seen_count` and event trend).
- **Confidence** — is the signal real: reproducible, linked evidence (event ids,
  file:line), file exists in the code index.
- **Success odds** — rolling success rate of that scanner/rule
  (`dev_autopilot_executions` outcomes).
- **Expected cost** — median tokens per execution for that scanner/rule.

`priority = value × confidence × success_odds / expected_cost`. A card is shown
only above a floor (e.g. confidence ≥ 0.6 and success odds ≥ 0.3).

### P3 — One quality pass before a card is shown

For candidates that pass P1/P2, one bounded `planner`-stage call (Bedrock,
with `dev_index_query` / `dev_get_risk`) writes: the concrete problem, the
evidence, the files and their change risk, acceptance criteria, and why now. No
concrete file or evidence → the candidate is dropped, not shown. Daily cap on
these calls.

### P4 — Stop spending tokens on work that does not land

1. Per-scanner / per-rule circuit breaker: below 20 % success over the last 10
   executions → stop auto-approving and stop surfacing it until changed.
   Today that switches off todo, large-file, safety-gap and npm-audit until they
   are fixed.
2. Before approval: the plan's files must exist and a paired test must be named;
   `large_file` refactors of 2,000+ line files are never auto-executed.
3. Token budget per finding (not only per run); an outage-class failure never
   re-queues the same finding more than once an hour.
4. Non-executable types (`oasis`, `roadmap`, `behavior`, system `health`) show
   "Create task", not "Activate", until they have an executor.

### P5 — Learn from decisions

Dismiss asks for a reason (not a real problem / not worth it / duplicate /
already fixed / wrong fix). Acceptance per source and rule feeds the P2 score
and the P4 breaker; a weekly summary goes to the Command Hub.

### P6 — The card

Show evidence, value, success odds and expected cost, an "executable"
badge, and after Activate the live execution state (this PR starts that).

## 5. Targets

| Metric | Now | Target |
|---|---|---|
| Recommendations accepted (activated or completed ÷ decided) | < 5 % | ≥ 50 % |
| Activate → execution created | 0 of last 6 | 100 % (or an explicit reason) |
| Activated → merged PR | ~0 for scanner findings (30 d) | ≥ 50 % |
| Input tokens per merged scanner PR | unbounded | tracked, budgeted |
| Open cards from known noise (terminal VTIDs, telemetry topics, intentionally absent env vars) | 10 roadmap + 2 health + telemetry oasis cards today | 0 |

## 6. Order

P1 and the popup sort are small, independent PRs and remove most of the noise
today. P4.1 (circuit breaker) stops the largest token spend. P2 and P3 follow,
then P5/P6.
