# Dataset extraction — PII filter policy

Phase 1 W1 (VTID-03178 DATASETS).

## Rule

A source row from `oasis_events` is included in extracted JSONL **only if all**
of the following hold:

1. **Topic does not match `safety.guardrail.*`.** Any row that the safety
   pipeline flagged or redirected is dropped wholesale, regardless of the
   redaction state of its payload.
2. **`metadata.data_export_ok === true`.** This is the per-row opt-in flag
   set by the producing surface when the originating user has consented to
   their content being used for model training. Rows without the flag are
   dropped, even if their payload appears innocuous.

The filter is applied at the **SQL layer** (via PostgREST `and=(...)` filter
in `lib.ts:queryOasisEvents`). Filtered rows never enter Node memory, never
appear in logs, never reach JSONL.

## Why both?

`safety.guardrail.*` covers content the system flagged automatically (e.g.
self-harm, illegal content, prompt-injection attempts). `data_export_ok`
covers user-level consent, which is independent — a user who hasn't opted in
shouldn't have their non-flagged data exported either.

## Where consent is set

The `data_export_ok` flag is set by surfaces that handle user input:
- `/orb/chat` and the voice live-session handlers (per-tenant policy)
- `memory.write.*` emitters (per-user opt-in)
- `autopilot.intent.created` (defaults to true when the originating thread
  is consented)

Surfaces that don't set the flag (e.g. internal diagnostics, system events)
get `data_export_ok` omitted, which the filter treats as "not opted in" and
drops.

## What if a row slips through?

The filter is defense-in-depth, not the only line. The downstream JSONL
files live in `gs://vitana-artifacts-staging/datasets/` with 180-day
retention; if a row needs to be removed retroactively, drop the JSONL file
that contains it and re-run the extractor for that day. The next training
run will use the updated corpus.

## Audit

Every extractor emits `dataset.extraction.completed` with:
- `rows_total` — events returned by the SQL query (already post-filter)
- `rows_after_dedup` — what actually landed in the JSONL

The gap between them is dedup, not PII. If you need to audit PII filtering
itself, query `oasis_events` directly with the same filter; the count should
match `rows_total`.
