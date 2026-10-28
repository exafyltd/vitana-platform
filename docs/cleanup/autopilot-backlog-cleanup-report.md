# Autopilot Backlog Cleanup Report

**Lane:** Autopilot Backlog Cleanup (`BOOTSTRAP-AUTOPILOT-BACKLOG-CLEANUP`)
**Date:** 2026-06-02
**Apply tool:** `services/gateway/scripts/autopilot/backlog-cleanup-apply.ts`
**Classification source (reused, not re-derived):** `services/gateway/scripts/autopilot/backlog-conversion-classifier.ts` (VTID-03232)

## Summary

The dev-autopilot `vtid_ledger` backlog has **21 stale/blocked rows**. The
existing W3-C1 conversion classifier already produced the authoritative
verdict (see `docs/PHASE-1-W3-C1-ACCEPTANCE.md`):

| Action | Count | This lane's behaviour |
|---|---:|---|
| `archive_stale_noise` | 10 | **ARCHIVE** (status=cancelled, is_terminal=true, terminal_outcome=cancelled) |
| `leave_in_operator_review` | 10 | **UNTOUCHED** |
| `needs_human_spec` | 1 | **UNTOUCHED** (human-spec item — VTID-01227) |
| `convert_to_dev_autopilot` | 0 | n/a (none convertible) |

The backlog is structurally **non-fuel** for Phase 1. The cleanup tool's only
job is to safely archive the 10 stale-noise rows so the operator's queue is no
longer cluttered, while leaving everything that needs human judgement intact.

## What would be archived (10 rows)

All 10 are `>30d` stale AND not Phase 1 relevant (product-side bug reports /
feature requests that don't intersect the latency/voice/cache/eval/ci/aws/dataset
bands). The classifier reason for each is `age <N>d > 30 AND no Phase 1
relevance — archive`. Top 3 (per the W3-C1 acceptance doc):

- **VTID-01869** (age≈69d) — "Gateway: Feature Request: Support attaching screenshots to ..."
- **VTID-01881** (age≈60d) — "Gateway: Fix chat history issues: older messages loading ..."
- **VTID-01882** (age≈60d) — "Gateway: Fix the bug in the 'Search tasks' input field"

(The exact live set of 10 is resolved at run time from prod `vtid_ledger` via
the classifier — the apply tool never hardcodes VTIDs.)

### Archive semantics

Archive is a **status transition, never a delete**:

- `status` → `cancelled` (the documented terminal "did not / will not run" enum value in CLAUDE.md §3)
- `is_terminal` → `true`
- `terminal_outcome` → `cancelled`
- `metadata.archived` → `{ by, action: "archive_stale_noise", reason, archived_at }` (merged into existing metadata; existing provenance preserved)

The PATCH is scoped to `vtid=eq.<id>` **and** `is_terminal=eq.false`, so it is
idempotent and can never re-terminalize an already-terminal row or touch a
sibling. No row is ever deleted.

## What is left untouched

### 10 operator-review rows (`leave_in_operator_review`)
Rows with no clear next step, or business/legal/prod-mutation signals. These
stay in the operator queue for human triage. The cleanup tool never modifies
them.

### 1 human-spec item (`needs_human_spec`)
- **VTID-01227** — "01228 - UNIFIED VITANA AUTH & Orb auth"
  - phase1 band: `voice`
  - classifier reason: Phase 1 relevant (voice) but lacks a file/surface hint
  - This is a sweeping unified-auth + ORB-auth migration. It is correctly
    **not** auto-convertible and **not** archived — it needs a human-authored
    spec before any execution. Left exactly as-is.

## Safety guarantees of the apply tool

1. **DRY-RUN by default.** Writes nothing unless invoked with `--execute --confirm=archive-stale`.
2. **Archives only `archive_stale_noise`.** It reads the classifier's
   `archive_candidates` list verbatim; `leave_in_operator_review`,
   `needs_human_spec`, and `convert_to_dev_autopilot` rows are never written.
3. **Never deletes.** Archive is a status/terminal transition only.
4. **Never modifies executor allowlists.** The tool only PATCHes the targeted
   `vtid_ledger` rows; it does not touch `autopilot-executable-source-types.ts`
   or the drain-plan `EXECUTABLE_ALLOWLIST`.
5. **Reuses existing classification.** No keyword bands, action ladder, or
   staleness thresholds are re-derived — it imports `generate()` from the
   shipped classifier.

## Usage

```bash
# Dry run (default) — prints the plan + per-row reasons, writes nothing
npx tsx services/gateway/scripts/autopilot/backlog-cleanup-apply.ts

# Apply (operator only) — archives ONLY the 10 archive_stale_noise rows
npx tsx services/gateway/scripts/autopilot/backlog-cleanup-apply.ts \
  --execute --confirm=archive-stale
```

Env required: `PROD_SUPABASE_URL`, `PROD_SUPABASE_SERVICE_ROLE`.
Optional: `REPORT_MARKDOWN_PATH` (writes a Markdown run summary).

## Status

- Tool written, type-checks clean, gateway build green (`tsc` exit 0).
- **No `--execute` run performed from this lane** — dry-run / artifact only.
- Recommended operator action: review this report, then run the apply tool
  with `--execute --confirm=archive-stale` to archive the 10 stale-noise rows.
