# Phase 1 W3-C0 acceptance — VTID-03224, VTID-03225, VTID-03227

**Window:** 2026-05-31
**Mode:** Autonomous (2 PRs as instructed + 1 column-fix + 1 doc PR)
**Plan:** [`.claude/plans/yes-make-a-week-by-week-wild-shore.md`](../.claude/plans/yes-make-a-week-by-week-wild-shore.md)
**Previous:** [`PHASE-1-W3-B1-ACCEPTANCE.md`](./PHASE-1-W3-B1-ACCEPTANCE.md)

## Headline

W3-C0 = autopilot backlog visibility + canary/gate Vertex IAM parity.
Both PRs shipped; the dev-autopilot queue now has a daily ranked
drain plan, and the canary readiness report's Vertex gate verdict
matches the phase-gate-status-report's verdict word-for-word.

Today's empty drain batch is the **correct** outcome — none of the
21 pending dev-autopilot rows meet the safety filters. The plan
surfaces *why* (no rows from allowlisted source_types, no plans
attached), not just "blocked".

## PRs

| PR | Title | Merged SHA |
|---|---|---|
| [#2451](https://github.com/exafyltd/vitana-platform/pull/2451) | feat(autopilot): backlog drain planner (VTID-03224) | merged |
| [#2452](https://github.com/exafyltd/vitana-platform/pull/2452) | fix(eval): canary Vertex probe parity (VTID-03225) | merged |
| [#2454](https://github.com/exafyltd/vitana-platform/pull/2454) | fix(autopilot): vtid_ledger column rename (VTID-03227) | merged |
| (this) | docs(phase-1): W3-C0 acceptance (VTID-03228) | — |

## Acceptance cascade

### CRON-AUTOPILOT-BACKLOG-DRAIN-PLAN
Run [26713733148](https://github.com/exafyltd/vitana-platform/actions/runs/26713733148) (post-fix):

```
pending: 21
auto_actionable: 0    blocked: 21
has_plan: 0           missing_plan: 21
stale 7d/14d/30d: 18/16/11

by_source_type:
  operator-chat: 10
  api: 6
  unknown: 5

by_phase1_relevance:
  voice: 1
  unrelated: 20

recommended_first_drain_batch: 0 (empty)
top_10_blocked_buckets:
  operator-chat (count=10): source_type not in executable allowlist
  api (count=6): source_type not in executable allowlist
  unknown (count=5): source_type not in executable allowlist
```

Honest read: the 21 pending rows are all operator-chat-originated
tasks (no scanner-fix / lint-fix / rule-fix rows queued), none have
plans attached, and only one is Phase 1 relevant. The drain lane is
genuinely empty today. The plan surfaces this clearly rather than
inventing candidates.

### PHASE-GATE-STATUS-REPORT
Run [26713466052](https://github.com/exafyltd/vitana-platform/actions/runs/26713466052):

```
overall: { open: 1, blocked: 4, unknown: 0, ready_for_w3_b_to_g: false }
first_blocker: prod_consent
blocked_by_priority: [prod_consent, vertex_iam, aws_mirror, dataset_rows]

vertex_iam: blocked
  detail: 'WIF SA lacks aiplatform.user; CRON-FINETUNE-TRAINER cannot create training jobs.'
  unblock: gcloud projects add-iam-policy-binding lovable-vitana-vers1 ...
```

### CANARY-READINESS-REPORT
Run [26713468522](https://github.com/exafyltd/vitana-platform/actions/runs/26713468522):

```
verdict: NOT_READY
finetune_status: iam_blocked    (was: skipped)
finetune_run [FAIL]: 'Vertex IAM blocked: WIF SA lacks roles/aiplatform.user;
  CRON-FINETUNE-TRAINER cannot queue. See PHASE-GATE-STATUS-REPORT for
  the gcloud unblock command.'
```

**Parity achieved.** Gate and canary reports now say the same thing
about the Vertex gate.

## What PR #2451 (VTID-03224) shipped

The backlog drain planner — a TS script + daily workflow that reads
prod `vtid_ledger` (layer=DEV, is_terminal=false, status pending/
scheduled/planned/planning/blocked) and produces a ranked plan with:

- **Totals:** by source_type, scanner/rule, risk_class, effort
  bucket, impact bucket, has_plan vs missing_plan, auto_actionable
  vs blocked, stale >7/14/30d, prior PR open/unmerged count, Phase 1
  relevance distribution (latency, voice, cache, eval, ci, aws,
  dataset, unrelated)
- **top_10_safe:** candidates passing every drain-safety filter,
  ranked by `(impact / max(1, effort)) * (1 + 0.25 * phase1_count)`
- **top_10_blocked_buckets:** dominant blocked source_types with
  sample VTIDs + main block reason
- **recommended_first_drain_batch:** top 3 safe candidates,
  diversity-filtered (no two from same source_type/scanner pair)
- **Notes:** explicit advisory text — "for operator review, do NOT
  run autonomously"

Read-only by design. Does not approve, execute, reject, snooze, or
modify any vtid_ledger row.

## What PR #2452 (VTID-03225) shipped

Canary Vertex probe parity fix:
- `.github/workflows/CANARY-READINESS-REPORT.yml`: widened grep
  (case-insensitive `permission|denied|403|aiplatform|forbidden|
  insufficient|customjobs|role/iam`) and new `FINETUNE_STATUS=iam_blocked`
  classification
- `services/gateway/scripts/eval/canary-readiness-report.ts`: explicit
  `iam_blocked` case in the FAIL reason switch surfacing the exact
  gcloud unblock command

After this PR + W3-B1's `PHASE-GATE-STATUS-REPORT` fix, both reports
use the same Vertex-error detection heuristic and produce consistent
verdicts.

## What PR #2454 (VTID-03227) shipped

Column-name slip in the drain planner (`description_md` →
`description`). First cron run failed PGRST 42703; three-line rename.
Likely a transcription artifact — `autopilot-event-loop.ts` uses
`description`, not `description_md`.

## Acceptance state vs the W3-C0 prompt

| Acceptance criterion | State |
|---|---|
| Drain plan workflow runs today | ✓ run 26713733148 succeeded post-fix |
| Plan reads the real queue | ✓ 21 pending rows from prod vtid_ledger |
| Plan produces a drain plan | ✓ JSON + Markdown artifacts uploaded |
| Plan does not approve/execute/reject/snooze | ✓ read-only by construction |
| Canary report says Vertex IAM is blocked/failed, not skipped/unknown | ✓ `finetune_status: iam_blocked` |
| Verdict remains NOT_READY | ✓ |
| Gate report and canary report agree on Vertex IAM gate | ✓ both say blocked, both mention roles/aiplatform.user |

## Honest observation: the drain lane is structurally idle today

The empty `recommended_first_drain_batch` is not a planner bug — it's
real evidence:

- The 21 pending dev-autopilot rows come from three source_types:
  `operator-chat` (10), `api` (6), `unknown` (5). None of these are
  in the `EXECUTABLE_ALLOWLIST` (which lists narrow scanner/lint/
  rule/docs-fix types intended for autonomous drain).
- Zero rows have a plan attached.
- Only one row is Phase 1 relevant (voice band keyword match).
- 11 rows are stale >30d.

**Implication for the operator:** the drain lane isn't going to drain
anything until either (a) the scanner pipeline starts feeding the
queue with executable types, or (b) a separate "planning automation"
PR adds plans to existing operator-chat tasks. Both are upstream of
W3-C0 and not in scope.

Today's drain-plan artifact is therefore most useful as a **diagnostic
of the queue's structural state**, not as a candidate list. The
top_10_blocked_buckets table makes the dominant reason ("source_type
not in executable allowlist") loud and clear.

## Standing posture unchanged

Same four trigger conditions for the next build wave:
1. Vertex IAM grant → W3-B (training run + monitor)
2. Prod consent → W3-C (extraction + corpus expansion)
3. AWS secrets → W3-D (S3 mirror smoke)
4. Organic staging voice traffic → real shadow evidence

The phase-gate-status-report + canary-readiness-report now agree on
all gate verdicts. The backlog-drain-plan adds a fifth daily artifact
the operator can use to confirm the dev-autopilot queue is not the
bottleneck.

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
| 03228 | w3-c0-acceptance-doc | this PR |
