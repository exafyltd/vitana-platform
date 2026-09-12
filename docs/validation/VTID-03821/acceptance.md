# VTID-03821 — Execution observability: real-vtid LLM telemetry

## Report

Part 4 (final) of the VTID-03818..03823 plan. Before writing any code,
researched every existing execution-observability surface — the Command
Hub Tasks board drawer's "OASIS Event Tracking" panel and the Agents
Control Plane's Pipelines trace view both already exist, both already
render a live OASIS-event feed filtered by a task's own VTID. Rebuilding
either was explicitly avoided.

The real, previously-invisible gap: `runExecutionSession()`
(`dev-autopilot-execute.ts`) tagged every LLM-call telemetry event
(`llm.call.started/completed/failed` — carrying provider, model, latency)
with a synthetic per-execution id (`VTID-DA-<execId8>`), never
`autopilot_recommendations.activated_vtid` — the real task VTID both
existing UIs filter events by. This telemetry has been invisible on every
dev-autopilot execution's own task (self-healing-triggered executions
included, not just VTID-03820's on-ramp) for as long as this code path has
existed. Fixed at the identifier level; no new UI, route, or table.

## Acceptance Criteria

AC-1 — The existing, already-unconditional `autopilot_recommendations`
query inside `runExecutionSession()` also selects `activated_vtid` — no
new database round trip added.

TEST: `test/vtid-03821-execution-telemetry-vtid.test.ts` — "selects
activated_vtid alongside spec_snapshot in the unconditional findingMetaR
query".

AC-2 — A new `telemetryVtid` prefers `activated_vtid` when present, and
falls back to the pre-existing synthetic id when absent (an old/unlinked
finding never gets a blank vtid on its telemetry).

TEST: same file — "computes telemetryVtid preferring activated_vtid,
falling back to the synthetic id".

AC-3 — Both LLM-invocation call sites — the direct `callMessagesApi` path
and the worker-queue `runWorkerTask` path's `vtid_like` field — use
`telemetryVtid` instead of the always-synthetic id. The old
always-synthetic call shape does not remain anywhere in the file.

TEST: same file — "the direct-API path tags callMessagesApi with
telemetryVtid" (also asserts the old literal call shape is gone) and "the
worker-queue path tags vtid_like with telemetryVtid too".

AC-4 — `telemetryVtid` is computed before the worker-queue-vs-direct-API
branch that consumes it (ordering matters — a later computation would be a
silent no-op for whichever branch runs first).

TEST: same file — "telemetryVtid is computed before the... branch that
consumes it".

AC-5 — No regression: the sibling VTID-03820 test asserting the old
call-site literal is updated to the new, intentional shape (not silently
loosened — it now asserts the accurate literal and separately documents
why it changed).

TEST: `test/vtid-03820-execution-onramp-metadata.test.ts` (updated) — "the
direct-API branch passes the override into callMessagesApi" now asserts
`callMessagesApi(prompt, telemetryVtid, onRampOverride)`.

AC-6 — `tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-vtid-03821-filter.txt` (2/2
suites, 15/15 tests); `outputs/jest-full-suite.txt` (749/750 suites — 1
pre-existing skip — 13,758/13,793 tests passing, 0 failures).

## Deliberately NOT attempted

- **No new Command Hub UI.** Both existing observability surfaces (the
  task drawer's OASIS Event Tracking panel, the Agents Control Plane
  Pipelines trace view) already render whatever OASIS events carry the
  task's own vtid — this fix makes the existing telemetry appear there for
  free. Building a NEW panel/badge would duplicate what already exists and
  overlaps with VTID-03822 (Operator chat cockpit UI, not selected in this
  chain) / VTID-03823 (Tasks board hygiene UI, not selected either).
- **No explicit "on_ramp: true" flag on the telemetry payload.** The
  existing `provider`/`model` fields already distinguish a DeepSeek
  on-ramp call (`provider: 'deepseek', model: 'deepseek-flash'`) from a
  self-healing execution's own Bedrock/Anthropic call — adding a redundant
  flag would be duplicating information the fields already carry, once
  actually visible.
- **No live execution run against the real repo to observe the fix.**
  Triggering a real Dev Autopilot execution (self-heal or on-ramp) to
  watch the telemetry land was out of scope for this session — verified by
  direct code reading and the regression tests above instead.
- **`vtidLike` at the git-commit-message call site (line ~1664,
  unrelated to telemetry) was left untouched.** That's a separate,
  cosmetic naming concern (what a commit message says), not "telemetry is
  invisible" — folding it in here would be unrelated scope creep on an
  otherwise narrowly-targeted fix.

This completes the approved VTID-03818→03819→03820→03821 build chain.
