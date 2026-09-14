# VTID-03846 — CLAUDE.md §2b: Bedrock invokable-profile table stale (Opus 4.5 invokes)

## Report

CLAUDE.md §2b carries a table, measured 2026-08-10, stating that of 22
`ACTIVE` Anthropic inference profiles only three invoke, and that "Every
Haiku / Opus profile" returns `AccessDeniedException`. On 2026-09-13, during
the operator on-ramp staging test, the self-heal retry child's worker call
ran on the `worker` routing-policy primary
`eu.anthropic.claude-opus-4-5-20251101-v1:0` and completed normally — 29.6s,
3,517 input / 2,768 output tokens (`oasis_events` `llm.call.completed`,
recorded read-only in
`docs/validation/VTID-03841/outputs/staging-observation-2026-09-13.txt`).
That is a real invocation, not a listing, so the blanket ❌ row is wrong for
this profile. Left as-is, a future session following §2b would treat the
live worker primary as unsubscribed and "fix" routing away from a working
model.

Change (doc-only): split the row. Opus 4.5 gets its own dated ✅ row with the
measurement; the ❌ row is scoped to "as measured 2026-08-10, only Opus 4.5
re-measured since" so it is neither over-trusted nor silently contradicted.
A CHANGE LOG row records the finding and the sibling follow-ups from the same
staging test. No code, no deploy.

## Acceptance Criteria

AC-1 — §2b lists `eu.anthropic.claude-opus-4-5-20251101-v1:0` as invokable
with the date and measurement.

TEST: `outputs/claude-md-grep.txt` — `grep -n "claude-opus-4-5-20251101" CLAUDE.md`
shows the ✅ row.

AC-2 — The ❌ row no longer claims every Opus profile fails; it is dated and
scoped.

TEST: same output — the ❌ row reads "every other Opus profile … as measured
2026-08-10".

AC-3 — CHANGE LOG has a VTID-03846 row.

TEST: same output — `grep -n "| VTID-03846 |" CLAUDE.md`.

## Not verified here

No other profile was re-invoked; the ❌ row's other entries remain as of
2026-08-10 and are labelled so. The Opus 4.5 measurement comes from a real
worker call observed in staging telemetry, not from a fresh
`invoke-model` from this session (no AWS credentials here).
