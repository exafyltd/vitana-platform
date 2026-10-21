# Feedback Cleanup Runbook

**Marker:** `BOOTSTRAP-FEEDBACK-CLEANUP`
**Companion to:** `feedback-cleanup-report.md`
**Golden rule:** transitions only, never deletes. The script defaults to DRY-RUN.

---

## 0. Prerequisites

- Service-role key for the dev Supabase project (the script reads/transitions via the
  service client, same path the supervisor UI uses).
- Node 18+ (the script uses `@supabase/supabase-js`, already a gateway dependency).
- Read the report first. Understand the four candidate classes (§6) and which are
  auto-safe (A) vs operator-confirm (C1/C2) vs report-only (B/C3/D).

```bash
export SUPABASE_URL="https://<dev-project>.supabase.co"
export SUPABASE_SERVICE_ROLE="<service-role-key>"
```

---

## 1. Inventory (read-only, no writes)

Run the SQL in `feedback-cleanup-report.md` §7 in the Supabase SQL editor, OR:

```bash
node scripts/cleanup/feedback-cleanup.mjs --inventory
```

`--inventory` only SELECTs. It prints counts by status, exact-dup clusters (Class A),
and stale candidates (Class C). Paste the counts into report §5.

---

## 2. Dry-run a cleanup class (default — no writes)

The script is **DRY-RUN by default**. Without `--execute` it prints exactly what it
*would* transition and exits 0 without mutating anything.

```bash
# Class A — exact duplicates the classifier missed (mark-duplicate → oldest)
node scripts/cleanup/feedback-cleanup.mjs --class A

# Class C1 — stale needs_more_info (reject with WONT_FIX reason)
node scripts/cleanup/feedback-cleanup.mjs --class C1 --stale-days 45

# Class C2 — stale p3 backlog (reject with WONT_FIX reason)
node scripts/cleanup/feedback-cleanup.mjs --class C2 --stale-days 60
```

Each line of output shows `[DRY-RUN] would {transition} {ticket_number} → {target}`.
Review the list. If anything looks wrong, adjust `--stale-days` or skip the class.

---

## 3. Apply (requires explicit `--execute`)

Only after reviewing the dry-run:

```bash
node scripts/cleanup/feedback-cleanup.mjs --class A --execute
node scripts/cleanup/feedback-cleanup.mjs --class C1 --stale-days 45 --execute
```

The script:
- Performs **only** `status` transitions (`duplicate` / `rejected`) plus the linked
  `duplicate_of` or `supervisor_notes` field — never `DELETE`.
- Skips any ticket already in a terminal status.
- Never touches the canonical of a duplicate cluster.
- Emits one OASIS-shaped log line per transition (so the operator can reconcile).
- Is **idempotent**: re-running after a successful apply is a no-op (terminal tickets
  are skipped).

> Class B (near-dupes), C3 (stale real bugs), and D (old resolved) are intentionally
> **report-only**. The script will refuse `--class B/C3/D --execute` and tell you to
> action them manually via the supervisor UI.

---

## 4. Apply manually via the supervisor API (alternative to the script)

If you prefer the governed HTTP path (identical effect), use the admin endpoints with an
operator bearer token. Resolve the gateway URL dynamically per CLAUDE.md:

```bash
GW=$(gcloud run services describe gateway --region=us-central1 \
      --project=lovable-vitana-vers1 --format="value(status.url)")

# mark a duplicate
curl -s -X POST "$GW/api/v1/admin/feedback/tickets/<dup-id>/mark-duplicate" \
  -H "Authorization: Bearer <operator-jwt>" -H "Content-Type: application/json" \
  -d '{"duplicate_of":"<canonical-id>"}'

# reject a stale ticket
curl -s -X POST "$GW/api/v1/admin/feedback/tickets/<id>/reject" \
  -H "Authorization: Bearer <operator-jwt>" -H "Content-Type: application/json" \
  -d '{"reason":"WONT_FIX: stale — no reporter response in 45d"}'
```

Confirm JSON (not HTML) responses per the deployment-verification protocol.

---

## 5. Verify after apply

```bash
node scripts/cleanup/feedback-cleanup.mjs --inventory
```

Counts in `duplicate` / `rejected` should have increased by exactly the number of
transitions you applied; open counts should have decreased by the same amount. No row
count should ever *decrease* in total (nothing is deleted).

---

## 6. Rollback

There is a feedback-rollback migration (`..._vtid_02702_feedback_rollback.sql`) for
pipeline-level rollback. For individual cleanup mistakes, simply re-transition via the
supervisor UI (e.g. `mark-duplicate` was wrong → move back to `triaged`). Because the
table is append-mostly and nothing is deleted, every transition is reversible.

---

## 7. Notes & gaps

- **`wont_fix` has no dedicated endpoint** — the script and runbook use `reject` with a
  `WONT_FIX:`-prefixed reason. Filter on `supervisor_notes LIKE 'WONT_FIX:%'` to find
  them. A dedicated `wont_fix` action is a recommended follow-up.
- **Semantic dedupe is approximate** — the `embedding` column exists but the embedding
  worker is not yet wired, so Class B uses pg_trgm text similarity. Keep it manual.
- **`feedback_tickets` has no `updated_at`** — staleness uses the `GREATEST(...)` of the
  timestamp columns. If a future migration adds `updated_at`, prefer it.
