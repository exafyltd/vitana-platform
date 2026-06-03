# Phase 1 W3-C1 acceptance — VTID-03232 + VTID-03233

**Window:** 2026-05-31
**Mode:** Autonomous (2 PRs as instructed + 1 doc PR)
**Plan:** [`.claude/plans/yes-make-a-week-by-week-wild-shore.md`](../.claude/plans/yes-make-a-week-by-week-wild-shore.md)
**Previous:** [`PHASE-1-W3-C0-ACCEPTANCE.md`](./PHASE-1-W3-C0-ACCEPTANCE.md)

## Headline

W3-C1 = "backlog conversion lane". Two PRs shipped: a read-only
classifier that for each blocked dev-autopilot row picks one of four
recommended actions, plus a dry-run convert-row script that previews
the converted row shape without writing.

**Verdict on the 21-row dev-autopilot backlog:** structurally
non-fuel for Phase 1. **Zero rows are convertible.** Recommended:
archive 10 stale rows, leave 1 for human spec (broad auth scope),
park the remaining 10 in operator review. Focus the autonomous loop
on the telemetry / model / AWS gates per the W3-B0/B1/C0 dashboards.

## PRs

| PR | Title | Merged SHA |
|---|---|---|
| [#2459](https://github.com/exafyltd/vitana-platform/pull/2459) | feat(autopilot): backlog conversion classifier (VTID-03232) | merged |
| [#2460](https://github.com/exafyltd/vitana-platform/pull/2460) | feat(autopilot): dry-run backlog convert-row script (VTID-03233) | merged |
| (this) | docs(phase-1): W3-C1 acceptance (VTID-03235) | — |

## Classifier verdict ([run 26716230776](https://github.com/exafyltd/vitana-platform/actions/runs/26716230776))

```
total_blocked: 21
convertible_count: 0

by_action:
  convert_to_dev_autopilot: 0
  needs_human_spec:         1
  archive_stale_noise:      10
  leave_in_operator_review: 10

by_phase1_relevance:
  voice:     1
  unrelated: 20
```

### The one human-spec candidate
- **VTID-01227** — "01228 - UNIFIED VITANA AUTH & Orb auth"
  - phase1: voice
  - reason: Phase 1 relevant (voice) but lacks file/surface hint
  - this is a sweeping unified-auth migration — correctly NOT auto-convertible

### The 10 archive candidates (top 3 shown)
- **VTID-01869** (age=69d) — "Gateway: Feature Request: Support attaching screenshots to ..."
- **VTID-01881** (age=60d) — "Gateway: Fix chat history issues: older messages loading ..."
- **VTID-01882** (age=60d) — "Gateway: Fix the bug in the 'Search tasks' input field"

All 10 are >30d stale, none Phase 1 relevant. Product feature requests / chat-UI bug reports that don't intersect with the latency/voice/cache/eval/ci/aws/dataset work bands.

## What PR #2459 (VTID-03232) shipped

`services/gateway/scripts/autopilot/backlog-conversion-classifier.ts`
plus `.github/workflows/CRON-AUTOPILOT-BACKLOG-CONVERSION-PLAN.yml`
(dispatch + daily 09:15 UTC, 15 min after the drain plan at 09:00).

Classifier logic — action ladder (first match wins):
1. business/legal keywords → `leave_in_operator_review`
2. prod-mutation keywords (flip/publish/canary/...) → `leave_in_operator_review`
3. stale >30d AND NOT Phase 1 relevant → `archive_stale_noise`
4. Phase 1 relevant + file/surface hint + fix-verb + risk low/medium/unknown → `convert_to_dev_autopilot`
5. Phase 1 relevant but unscoped OR research-phrased → `needs_human_spec`
6. otherwise → `leave_in_operator_review`

Each classification carries:
- per-row `reasons[]` array so the operator can audit
- `proposed_scanner_label` (e.g. `backlog-conversion-v1::voice`) for
  rows recommended for conversion

Read-only by construction. Does not write to `vtid_ledger`.

## What PR #2460 (VTID-03233) shipped

`services/gateway/scripts/autopilot/backlog-convert-row.ts` — single-
row converter, dry-run by default.

Dry-run path (default):
- Looks up the source row by `--id=<vtid>`
- Allocates a fresh new VTID (so the preview shows the exact id the
  insert would use; one VTID burned per dry-run preview — transparent
  cost)
- Prints the proposed converted row in full JSON shape

The converted row shape:
- `source_type = dev_autopilot`
- `scanner = backlog-conversion-v1`
- `source_ref = <original row vtid>`
- `risk_class` preserved if low/medium, otherwise downgraded to medium
- `auto_exec_eligible = false` (NEVER auto-runs; operator still
  decides next step)
- `spec_snapshot` = `{ original_title, original_summary,
   original_source_type, original_created_at, proposed_file_hints }`
  where `proposed_file_hints` is regex-extracted from title/summary/
  description (paths, file extensions, route/module references)
- description appends a conversion-provenance footer with the source
  vtid, original source_type, conversion timestamp, and an explicit
  "auto_exec_eligible=false: operator must still review + execute
  manually" reminder

Execute path (operator only):
- Requires `--execute --confirm=convert-one --id=<vtid>`
- One row per invocation. No bulk path. No iteration. No workflow.

## Acceptance vs the W3-C1 prompt

| Criterion | State |
|---|---|
| Classifier reads the 21 blocked rows | ✓ |
| Produces a conversion plan | ✓ JSON + Markdown artifacts |
| Does not mutate anything | ✓ read-only by construction |
| Conversion script prints valid converted recommendation in dry-run | ✓ default mode + new VTID allocated for preview |
| --execute requires explicit confirm + id | ✓ both checks present + early exit |
| No CI/auto-workflow executes the converter | ✓ no workflow created for it |

## What this means operationally

The user's W3-C1 prediction was right:

> If zero are convertible, we archive/ignore this backlog for Phase 1
> and focus only on telemetry/model/AWS gates.

That's exactly today's situation. The 21 backlog rows are a mix of:
- **Old product-side bug reports + feature requests** (10 archive
  candidates: chat UI, search input, screenshot attachments — not
  Phase 1 fuel)
- **One sweeping unified-auth migration** (VTID-01227 — needs human
  spec; not an autopilot-shaped task)
- **10 operator-review rows** with no clear next step

Recommendation: don't run the backlog. Run the dashboards (drain plan
+ gate report + canary readiness) every day, and act on whichever of
the 3 operator gates lifts first (Vertex IAM / prod consent / AWS
secrets). The autopilot queue is not the bottleneck.

## Daily cron cadence now standing

- 07:30 UTC — `EXERCISE-STAGING-SHADOW` (W3-B1)
- 08:15 UTC — `CRON-SHADOW-COMPARISON-REPORT` (W3-A)
- 08:30 UTC — `PHASE-GATE-STATUS-REPORT` (W3-B0/B1)
- 08:45 UTC — `CANARY-READINESS-REPORT` (W3-B0/C0)
- 09:00 UTC — `CRON-AUTOPILOT-BACKLOG-DRAIN-PLAN` (W3-C0)
- 09:15 UTC — `CRON-AUTOPILOT-BACKLOG-CONVERSION-PLAN` (this PR)

Six daily artifacts. The operator can read them in order and have a
complete picture of: what staging signal looks like → which gates are
blocked → whether canary is ready → what's in the queue → which queue
rows can be converted into fuel.

## Standing posture unchanged

Same four trigger conditions for the next build wave:
1. Vertex IAM grant → W3-B (training run + monitor)
2. Prod consent → W3-C (extraction + corpus expansion — real one)
3. AWS secrets → W3-D (S3 mirror smoke)
4. Organic staging voice traffic → real shadow evidence

## Cumulative Phase 1 W3 VTIDs

| VTID | Slug | Purpose |
|---|---|---|
| 03212 | shadow-comparison-report | W3-A |
| 03214 | stage-deploy-bind-service-token | W3-A bridge |
| 03215 | staging-shadow-exerciser | W3-B0 |
| 03216 | phase-gate-status-report | W3-B0 |
| 03217 | canary-readiness-report | W3-B0 |
| 03219 | canary-workflow-quote-fix | W3-B0 fix |
| 03220 | w3-b0-acceptance-doc | W3-B0 doc |
| 03221 | exerciser-dual-emit | W3-B1 |
| 03222 | gate-probe-iam-deterministic | W3-B1 |
| 03223 | w3-b1-acceptance-doc | W3-B1 doc |
| 03224 | autopilot-backlog-drain-planner | W3-C0 PR 1 |
| 03225 | canary-vertex-probe-parity | W3-C0 PR 2 |
| 03227 | drain-plan-column-fix | W3-C0 fix |
| 03228 | w3-c0-acceptance-doc | W3-C0 doc |
| 03232 | backlog-conversion-classifier | W3-C1 PR 1 |
| 03233 | backlog-convert-row-dry-run | W3-C1 PR 2 |
| 03235 | w3-c1-acceptance-doc | this PR |
