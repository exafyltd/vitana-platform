# Eval scripts — Phase 1 W3-A (VTID-03212)

Operator-facing eval tooling that runs OUTSIDE the gateway request path.
This directory is distinct from `services/gateway/test/eval/` (W1's
golden-corpus replay runner, which is a test harness).

## `shadow-comparison-report.ts`

Aggregates `eval.shadow.compared` events from the last N hours into a
per-feature rollup so the graduation recommender + canary-readiness
report have evidence to look at.

### Run it

Locally (one-shot):
```bash
GATEWAY_SERVICE_TOKEN=<token> \
WINDOW_HOURS=24 \
REPORT_MARKDOWN_PATH=/tmp/shadow-report.md \
  npx tsx services/gateway/scripts/eval/shadow-comparison-report.ts > /tmp/shadow-report.json
```

In CI: see `.github/workflows/CRON-SHADOW-COMPARISON-REPORT.yml` — daily
schedule, runs after the graduation recommender's 09:00 CET tick.

### What it reads

A staging-only admin endpoint added in the same PR:
```
GET /api/v1/admin/staging/eval/shadow-comparison-report?window_hours=24
Authorization: Bearer ${GATEWAY_SERVICE_TOKEN}
```

The endpoint does the SQL aggregation in-process using the gateway's
already-bound staging Supabase client (`getSupabase()`), so the script
itself needs no Supabase access — same pattern as the consent-flip
endpoint shipped in W2. Authentication is via `GATEWAY_SERVICE_TOKEN`;
the endpoint refuses with 403 outside `VITANA_ENV=staging`.

### Insufficient-data behavior

When no `eval.shadow.compared` events exist in the window, the endpoint
returns `200 OK` with `insufficient_data: true` and an empty
`features: []` array. The script writes a Markdown report that says
"Insufficient shadow data" explicitly rather than failing — that's the
expected state until staging voice traffic accumulates against the
`FEATURE_SHADOW_TOOL_ROUTER_ENV=staging-only` path.

The W2 cascade enabled the shadow path on staging but staging carries
zero organic voice traffic, so reports will start populating once
operators actually exercise the staging Command Hub voice surfaces (or
the user-facing `/orb/chat` text path on staging).

### Per-feature rollup columns

| Column | What it means |
|---|---|
| `n` | Total comparisons in window |
| `agreement` | % where primary + candidate produced the same `extractKey` result |
| `mismatch` | % where they disagreed (only counted when both produced a comparable key) |
| `primary p50/p95` | Latency percentiles of the primary path |
| `candidate p50/p95` | Same for the candidate (shadow) path |
| `Δ p50 / Δ p95` | Candidate latency relative to primary (negative = faster) |
| `err rate` | Fraction of comparisons where candidate threw |
| `fallback` | Count of `no_decision` or `candidate_fallback` outcomes |

### Graduation thresholds

Same as the hourly auto-promoter (`scripts/auto-promoter.ts`):

- min samples per feature: **200**
- min agreement: **92%**
- max candidate p95: **800ms**
- max candidate error rate: **2%**

A feature passing all four for ≥5 consecutive days is what the
graduation recommender (`scripts/graduation-recommender.ts`) flags as
PUBLISH-ready in its daily FCM digest. This script is the evidence the
operator inspects before clicking PUBLISH on the prod Command Hub
canary path.

### What this script does NOT do

- Does not modify auto-promoter DRY/LIVE state.
- Does not promote any fine-tune.
- Does not touch prod telemetry — staging only by hard guard.
- Does not synthesize rows when staging is empty — "insufficient data"
  is honest output, not a hidden failure.
