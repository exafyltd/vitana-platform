# Eval harness — Phase 1 W1 (VTID-03177 PROFILE)

Replays a golden corpus of recorded sessions against a configurable gateway
URL and produces a per-fixture latency roll-up. The runner is intentionally
small in W1; substantive checks (tool-routing accuracy, transcript quality,
shadow-comparator integration) land in W2+ alongside the fine-tune pipeline.

## Run it

```bash
# Against staging (default)
npx tsx services/gateway/test/eval/replay-runner.ts

# Against a custom gateway
EVAL_GATEWAY_URL=https://gateway.vitanaland.com \
  npx tsx services/gateway/test/eval/replay-runner.ts
```

Output is JSON to stdout. The `totals.p95_ms` line is the W1 baseline that
W2–W5 compare against.

## Corpus expansion

W1 ships 3 synthetic fixtures as a smoke seed. The plan calls for **50
fixtures by end of W1** (expanding to 400 by end of W5).

The W2 expansion uses the dataset extraction loop (PR #2 DATASETS): the
extractor pulls anonymized prod conversation_messages and writes each
qualifying session out as a fixture under this directory. Until that lands,
add fixtures manually in the same shape — see [types.ts](./types.ts) for the
canonical schema.

PII rule: prod-extracted fixtures must pass the same filter as datasets —
skip any session tagged `safety.guardrail.*` or where the source row lacks
`data_export_ok=true`.

## Schema

A fixture is one JSON file under `golden-corpus/`, matching
`GoldenCorpusFixture` in [types.ts](./types.ts).

## What the runner measures today

Per turn: total wall-clock round-trip to `/api/v1/admin/health`, plus any
`Server-Timing` phases the response carries. Per fixture: p50/p95/p99 across
its turns. Per run: roll-up across all fixtures.

## What it will measure once PR #1 follow-ups land

Once `orb-live.ts` emits the 5 phased latency events
(`audio_in_first_byte` → `audio_out_first_chunk`) and the eval harness is
allowed to exercise real chat turns instead of the health probe, the runner
will read those events back via Supabase and turn them into the same
`ReplayPhaseTiming[]` shape.
