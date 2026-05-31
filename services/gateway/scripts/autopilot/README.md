# Autopilot scripts — Phase 1 W3-C0 (VTID-03224)

Operator-facing tooling for the dev-autopilot queue. Read-only by
design — these scripts produce evidence + recommendations, never
execute, approve, reject, or snooze anything.

## `backlog-drain-plan.ts`

Reads pending dev-autopilot rows from prod `vtid_ledger` and produces
a ranked execution plan. Used by the daily
`CRON-AUTOPILOT-BACKLOG-DRAIN-PLAN` workflow + runnable locally for
spot-checks.

### What it queries

```
GET /rest/v1/vtid_ledger
   ?layer=eq.DEV
   &is_terminal=eq.false
   &status=in.(pending,scheduled,planned,planning,blocked)
   &order=created_at.asc&limit=5000
```

Reads prod via the WIF SA's existing `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE` Secret Manager grants (W1).

### What it produces

JSON + Markdown with:

- **totals** — pending count, per-source-type counts,
  scanner/rule counts, risk_class distribution, effort/impact buckets,
  has_plan vs missing_plan, auto_actionable vs blocked, stale
  >7d/>14d/>30d, prior failed/unmerged PR count, Phase 1 relevance
  buckets (latency, voice, cache, eval, ci, aws, dataset, unrelated)
- **top_10_safe** — candidates that pass every drain-safety filter,
  ranked by `(impact / max(1, effort)) * (1 + 0.25 * phase1_count)`
- **top_10_blocked_buckets** — biggest noisy buckets with sample VTIDs
  + the dominant block reason
- **recommended_first_drain_batch** — top 3 safe candidates,
  diversity-filtered (no two from the same source_type/scanner pair).
  **For operator review only.** Not auto-executed.

### Safety classifier (intersection of all rules must pass)

| Rule | Meaning |
|---|---|
| `EXECUTABLE_ALLOWLIST` membership | source_type ∈ {scanner-fix, lint-fix, rule-fix, docs-fix, config-cleanup, test-add, unused-removal, comment-fix} |
| `risk_class ∈ {low, medium}` | high-risk requires human |
| `effort_score <= 3` | small only |
| `impact_score >= 1` | non-null + non-zero |
| `has_plan` | metadata.plan_id, plan_url, plan_path, or has_plan=true |
| no active execution | status NOT in {scheduled, in_progress} |
| no prior open PR | metadata.prior_pr_open !== true |
| age <= 30d | older flagged stale + excluded from first batch |
| Phase 1 relevant | title/summary/description hits one of the 7 keyword bands |

### Run it locally

```bash
PROD_SUPABASE_URL=<…> PROD_SUPABASE_SERVICE_ROLE=<…> \
REPORT_MARKDOWN_PATH=/tmp/plan.md \
  npx tsx services/gateway/scripts/autopilot/backlog-drain-plan.ts > /tmp/plan.json
```

In CI: `.github/workflows/CRON-AUTOPILOT-BACKLOG-DRAIN-PLAN.yml`
fires daily at 09:00 UTC and on `workflow_dispatch`. Both artifacts
upload with 90-day retention; Markdown appended to the run's
GitHub step summary.

### What this script does NOT do

- Does not call any execute endpoint
- Does not approve / reject / snooze any pending row
- Does not modify any vtid_ledger row
- Does not flip auto-promoter out of DRY mode
- Does not synthesize candidates — all rows come from the real prod queue

### How to act on the recommendation

1. Operator reads the daily artifact (workflow summary or download).
2. For each of the recommended 3, confirm by hand that the plan exists
   and the metric improvement claim is real.
3. Trigger execution one at a time via the existing dev-autopilot
   execute path (NOT via this planner). Watch the result before
   moving to the next.
4. Re-run this planner the next day to see the new top-3.
