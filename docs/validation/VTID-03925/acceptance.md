# VTID-03925 — Command Hub Overview: fetchPipelineSummary() infinite-loop fix

## Reported issue

Live report, with real browser DevTools evidence, immediately after VTID-03917
(the prior fix for this same screen) deployed to staging: the System Overview
screen was **still** freezing — "i have entered this screen and now its
frozen. i cant move nowhere." A screenshot of the Console tab showed hundreds
of rapidly-repeating errors (691+ and climbing):

```
GET https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/pipeline/summary 401 (Unauthorized)
[Pipeline] Failed to fetch summary: Error: Pipeline summary fetch failed: 401
```

## Root cause

`fetchPipelineSummary()` (`app.js`) set `state.overviewPipelineSummary.fetched
= true` **only inside the try block, on success**. Every sibling fetcher in
this file (`fetchActionRequired`, `fetchServiceHealth`, ...) sets `fetched =
true` unconditionally in a `finally`/post-try-catch block, precisely so a
failure is still "handled" and does not retry forever.

Because `GET /api/v1/autopilot/pipeline/summary` 401s for every browser
caller — the whole `/api/v1/autopilot/*` router is gated by
`routes/autopilot.ts`'s `requireServiceToken`, which checks the request's
bearer token against `process.env.GATEWAY_SERVICE_TOKEN`, an internal
service-to-service secret a browser session can never legitimately hold —
`fetched` stayed `false` forever. `renderOverviewSystemView()` re-triggers
`fetchPipelineSummary()` on every render while `!fetched`, and
`fetchPipelineSummary()`'s own `isInitialLoad` branch calls `renderApp()` on
both entry and exit while `!fetched`. The result is a tight, self-sustaining
`fetch → renderApp() → fetchPipelineSummary() → fetch → ...` loop, bounded
only by round-trip latency — which pegs the browser's main thread and
presents exactly as "frozen, can't move anywhere," while flooding the
console with repeating 401s.

This is a different, independent bug from VTID-03917 (which fixed the 30s
Action Required poll's unconditional full re-render) — both happened to
produce a similar-looking "flickering/frozen" symptom on the same screen.

## Fix

`fetchPipelineSummary()`'s `finally` block now sets
`state.overviewPipelineSummary.fetched = true` unconditionally, matching the
established sibling-fetcher pattern in this file — so a persistent failure
(this 401, or any other future transient error) can no longer cause an
infinite retry-render loop. The bearer token is also now attached via
`buildContextHeaders()` for consistency with sibling fetches, though this
does **not** resolve the underlying 401 by itself (see "Known limitation"
below).

## Acceptance Criteria

AC-1: `fetchPipelineSummary()` sets `fetched = true` unconditionally in its
`finally` block, not only inside the `try` block on success.
TEST: `services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts`
  — "sets state.overviewPipelineSummary.fetched = true unconditionally in
  the finally block" and "the try block no longer sets fetched = true itself".

AC-2: A persistent failure of this endpoint can no longer cause
`renderOverviewSystemView()` to re-trigger the fetch on every render — the
`!fetched` guard that gated the original loop is now satisfied after the
very first attempt, success or failure.
TEST: `services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts`
  — "still only calls fetchPipelineSummary() when not already
  fetched/loading (guard unchanged)".

AC-3: Downstream consumers of `state.overviewPipelineSummary.snapshot`
(the metrics grid, the VTID attention section) already null-guard every
field they read, so a snapshot that stays permanently `null` (because the
401 is a real, unresolved backend gap — see below) degrades gracefully to
"—"/"No data" placeholders instead of throwing.
TEST: `services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts`
  — "renderOverviewSystemView's metrics grid null-guards every summary
  field it reads" and "renderVtidAttentionSection() null-guards the
  attention_queue array and returns null when empty".

AC-4: A successful response still populates the snapshot and clears any
prior error state (unchanged behavior).
TEST: `services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts`
  — "a successful response still populates the snapshot and clears any
  prior error".

AC-5: A failure is still logged to the console and recorded in
`state.overviewPipelineSummary.error`, not silently swallowed — this fix
stops the infinite loop, it does not hide the underlying problem.
TEST: `services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts`
  — "a failure is still logged and recorded, not silently swallowed".

AC-6: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011).

## Known limitation — the underlying 401 is a real, separate backend gap

This fix stops the **infinite loop and the freeze**. It does **not** make
`GET /api/v1/autopilot/pipeline/summary` actually succeed for the Command
Hub — that endpoint requires `GATEWAY_SERVICE_TOKEN`, an internal secret
that must never be exposed to a browser (VTID-03598 deliberately locked
this router down; sending that secret to the browser would reintroduce
exactly what VTID-03598 fixed: "anyone on the internet could drive the
autopilot pipeline"). So the Overview screen's pipeline-derived metrics
(Automation Rate, Workers, the VTID attention queue) will continue to show
"—"/"No data" placeholders rather than real data — a real, pre-existing
product gap, not something this fix could safely resolve. The actual fix
for that gap is a backend routing change: exempt this specific read-only
dashboard endpoint (and likely its siblings `/controller/status` and
`/loop/status`, which have the same problem and are already silently
degrading the same way in `fetchOverviewDashboard()`) from
`requireServiceToken`, gated instead by normal user/admin auth — the same
way `/health`, `/pipeline/health`, etc. are already exempted. That is a
security-relevant backend change deserving its own deliberate review, and
is flagged here rather than attempted blind in this pass.

As with VTID-03917, this session has no Command Hub admin login
credentials for `preview-aws-gateway.vitanaland.com` and does not attempt
to obtain or guess one — verification above is static/source-level only.
`outputs/` is present (Evidence Pack Gate requirement) but intentionally
empty.
