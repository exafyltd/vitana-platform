# Phase evidence digests

Consolidated, dated roll-ups of the standing Phase 1 evidence sources —
one artifact per day for the operator's daily rhythm.

**BOOTSTRAP-EVIDENCE-ARTIFACTS** — read-only. The digest emits no
`oasis_events`, writes no GCS/JSONL, flips no state, performs no deploy. It
only aggregates the output of reports that already exist.

## What it rolls up

| Source | Reused from | What it contributes |
|---|---|---|
| Phase gate status | `services/gateway/scripts/eval/phase-gate-status-report.ts` (`generate()`) | Which of the 5 operator-side gates are open/blocked/unknown + first blocker |
| Shadow comparison | `services/gateway/scripts/eval/shadow-comparison-report.ts` (`fetchReport()`) | Per-feature shadow rollup (agreement, candidate p95, error rate) over the window |
| Canary readiness | `services/gateway/scripts/eval/canary-readiness-report.ts` (`generate()`) | `READY_FOR_CANARY` / `NOT_READY` verdict + per-rule reasons |
| Dataset preview counts | `services/gateway/scripts/datasets/*.ts` in `DATASET_PREVIEW` mode | Rows that WOULD extract per target (read-only projection, nothing written) |

The digest never duplicates the underlying logic — it imports each report's
exported generator and aggregates. If any one source is unavailable (missing
creds/token, network blip), that section degrades to `unavailable` and the
rest of the digest still renders.

## How it runs

`.github/workflows/PHASE-EVIDENCE-DIGEST.yml` — daily at 09:00 UTC, 15 min
after the canary-readiness report (08:45 UTC) so the verdict it reads is the
freshest one. The chain is:

```
08:15 shadow-comparison → 08:30 phase-gate → 08:45 canary → 09:00 digest
```

The workflow uploads `phase-evidence-digest.{json,md}` as a 90-day artifact
and appends the Markdown to the run's step summary (same pattern as the three
reports it aggregates). It does NOT auto-commit digests into this directory.

## Run it locally

```bash
cd services/gateway
GATEWAY_SERVICE_TOKEN=<token> \
PROD_SUPABASE_URL=<url> PROD_SUPABASE_SERVICE_ROLE=<key> \
DATASET_PREVIEW_ENABLED=1 \
DIGEST_MARKDOWN_PATH=/tmp/digest.md DIGEST_JSON_PATH=/tmp/digest.json \
  npx tsx scripts/eval/phase-evidence-digest.ts > /tmp/digest.stdout.json
```

With no creds, each prod-backed section reports `unavailable` and the digest
still produces — the unattended-daily contract.
