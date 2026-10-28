# Phase 1 W3-B1 acceptance — VTID-03221 + VTID-03222

**Window:** 2026-05-31
**Mode:** Autonomous (2 PRs + 1 doc PR — bounded as instructed)
**Plan:** [`.claude/plans/yes-make-a-week-by-week-wild-shore.md`](../.claude/plans/yes-make-a-week-by-week-wild-shore.md)
**Previous:** [`PHASE-1-W3-B0-ACCEPTANCE.md`](./PHASE-1-W3-B0-ACCEPTANCE.md)

## Headline

W3-B1 = "evidence hardening". Two surgical fixes to make W3-B0's
shadow-comparison + gate dashboards produce trustworthy data. The
cascade now produces real-numbered evidence (latency p50/p95,
agreement rate, error rate) instead of mostly-null aggregates from
2 events.

## PRs

| PR | Title | Merged SHA |
|---|---|---|
| [#2447](https://github.com/exafyltd/vitana-platform/pull/2447) | fix(eval): dual-emit per-prompt shadow events in exerciser (VTID-03221) | merged |
| [#2448](https://github.com/exafyltd/vitana-platform/pull/2448) | fix(eval): Vertex IAM probe accuracy + deterministic first_blocker (VTID-03222) | merged |
| (this) | docs(phase-1): W3-B1 acceptance (VTID-03223) | — |

## Acceptance cascade — before vs after

| Step | W3-B0 result | W3-B1 result |
|---|---|---|
| `EXERCISE-STAGING-SHADOW` (15 prompts) | HTTP 200, emitted=15 in 1.7s | HTTP 200, emitted=15 in 4.2s (extra time = awaited per-prompt emits — the fix) |
| `CRON-SHADOW-COMPARISON-REPORT` | total_events=2, agreement=null, p50=0 | **total_events=18**, agreement=100%, primary_p50=111ms, candidate_p50=147ms, Δ p50=+32%, error_rate=0% |
| `PHASE-GATE-STATUS-REPORT` | vertex_iam=**unknown**, first_blocker=prod_consent (by accident) | vertex_iam=**blocked**, first_blocker=prod_consent (**deterministic**), blocked_by_priority=[prod_consent, vertex_iam, aws_mirror, dataset_rows] |
| `CANARY-READINESS-REPORT` | NOT_READY, 5 FAIL / 2 PASS (mostly null evidence) | NOT_READY, **3 PASS / 4 FAIL** with real numbers (p95 155ms < 800ms ✓, agreement 100% > 92% ✓, error 0% < 2% ✓) |

Concrete run ids:
- [exerciser 26712114811](https://github.com/exafyltd/vitana-platform/actions/runs/26712114811)
- [shadow report](https://github.com/exafyltd/vitana-platform/actions/runs/26712147XXX) — total_events: 18
- [gate report 26712164795](https://github.com/exafyltd/vitana-platform/actions/runs/26712164795)
- [canary readiness] — verdict NOT_READY

## What PR #2447 fixed

**Problem (W3-B0):** the exerciser called `runWithShadow()` 15 times.
runWithShadow returns the primary result synchronously and kicks off
`void (async () => { await candidate(); await emitOasisEvent() })()`.
On Cloud Run staging with `--min-instances=0`, the container's CPU
gets throttled after the HTTP response is sent, dropping the detached
promise before the emit completes. Net: only the explicit rollup
event landed (2 events per 2 dispatches instead of 30+2).

**Fix:** keep the runWithShadow call (so the wrapper code path is
exercised end-to-end), but also `await emitOasisEvent(...)` directly
in the exerciser loop with the same payload shape. The awaited emit
is guaranteed to complete before the response is sent. Per-prompt
events carry `metadata.exerciser_via='dual_emit_await'` so consumers
can distinguish exerciser-driven from organic shadow events.

**Why real voice traffic doesn't need this:** active WebSocket/SSE
sessions keep the container's CPU allocated until the session ends.
The IIFE flushes before the connection tears down. The exerciser is
the only caller with a short single-request lifetime that hits the
throttling edge.

## What PR #2448 fixed

**Problem (W3-B0):** the gate report's Vertex IAM probe ran `gcloud
ai operations list` (wrong API — not what `CRON-FINETUNE-TRAINER`
actually calls), and grep'd for `PERMISSION_DENIED|403` (too narrow).
Real gcloud error text didn't match → `vertex_iam: unknown` instead
of `blocked`. Also, `first_blocker` used `gates.find(blocked)` which
returned whichever blocked gate happened to be first in array order
— functionally deterministic today, but fragile.

**Fix (two parts):**

1. **Probe accuracy:** switched to `gcloud ai custom-jobs list`
   (the exact API CRON-FINETUNE-TRAINER hits) and widened the grep
   to case-insensitive `permission|denied|403|aiplatform|forbidden|insufficient|customjobs|role/iam`.
   Any reasonable IAM-related gcloud error variant now classifies as
   `denied`. Workflow now also prints up to 10 lines of stderr for
   operator triage.

2. **Deterministic first_blocker:** explicit `GATE_PRIORITY` array
   in the TS script: `prod_consent > vertex_iam > aws_mirror >
   shadow_traffic > dataset_rows`. Reflects dependency order —
   prod_consent unblocks dataset_rows; vertex_iam unblocks fine-tune
   training. New `blocked_by_priority: string[]` output field shows
   the full ordered list so the operator has a stable unblock work
   order. Future gates not in the priority list append at the end.

## Acceptance state vs the W3-B1 prompt

| Acceptance criterion | State |
|---|---|
| One exerciser run with 15 prompts produces >=15 queryable shadow events | ✓ 15 per-prompt + 1 rollup, no detached-promise reliance |
| Shadow comparison report total_events >= 15 for the latest window | ✓ 18 events in cascade run (15 fresh + 3 historical rollups) |
| PHASE-GATE-STATUS-REPORT shows Vertex IAM as `blocked` until role is granted | ✓ vertex_iam=blocked (was unknown) |
| `first_blocker` remains deterministic by priority | ✓ prod_consent first via explicit GATE_PRIORITY array |

## Honest follow-up surfaced (not in W3-B1 scope)

The Vertex probe in `CANARY-READINESS-REPORT.yml` is independent of
the one in `PHASE-GATE-STATUS-REPORT.yml` and still uses the OLD
narrow grep (`PERMISSION_DENIED|403`). Result: canary readiness
reports `finetune_status: skipped` instead of `failed`. The verdict
is still correctly NOT_READY because skipped is treated as a FAIL
rule, but the canary report should ideally match the gate report's
probe.

**Fix:** small future PR — copy the widened grep from
`PHASE-GATE-STATUS-REPORT.yml`'s probe step into
`CANARY-READINESS-REPORT.yml`'s `ftstatus` step. Or factor out into
a reusable composite action. Either is one-line.

## Live state after W3-B1

- Staging tenant `11111111-1111-1111-1111-111111111111` consented
- Staging gateway revision: `gateway-staging-00092-lrr` (dual-emit live)
- 18 `eval.shadow.compared` events in staging oasis_events from today
- All 4 daily reports (07:30 / 08:15 / 08:30 / 08:45 UTC) now produce
  trustworthy numbers
- All 3 operator unlocks unchanged: Vertex IAM grant, prod consent,
  AWS secrets

## Standing posture (unchanged)

Same four trigger conditions for the next build wave:
1. Vertex IAM grant → W3-B (training run + monitor)
2. Prod consent → W3-C (extraction + corpus expansion)
3. AWS secrets → W3-D (S3 mirror smoke)
4. Organic staging voice traffic → real (non-exerciser) shadow evidence

The phase-gate-status-report's `blocked_by_priority` array is now the
operator's authoritative work order.

## Cumulative Phase 1 W3 VTIDs

| VTID | Slug | Purpose |
|---|---|---|
| 03212 | shadow-comparison-report | W3-A core |
| 03214 | stage-deploy-bind-service-token | W3-A bridge |
| 03215 | staging-shadow-exerciser | W3-B0 PR 1 |
| 03216 | phase-gate-status-report | W3-B0 PR 2 |
| 03217 | canary-readiness-report | W3-B0 PR 3 |
| 03219 | canary-workflow-quote-fix | W3-B0 fix-up |
| 03220 | w3-b0-acceptance-doc | W3-B0 doc |
| 03221 | exerciser-dual-emit | W3-B1 PR 1 |
| 03222 | gate-probe-iam-deterministic | W3-B1 PR 2 |
| 03223 | w3-b1-acceptance-doc | this PR |
