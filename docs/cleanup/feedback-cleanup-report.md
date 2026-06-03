# Feedback Cleanup Report

**Lane:** Feedback Cleanup (Vitana 35-day program)
**Marker:** `BOOTSTRAP-FEEDBACK-CLEANUP`
**Date:** 2026-06-02
**Mode:** Read-only inventory + tooling. **No deletions** — status transitions only.

---

## 1. Where feedback lives

Two distinct stores exist. They use the *word* "feedback" but are different concepts.

| Store | Migration | Concept | Cleanup relevance |
|-------|-----------|---------|-------------------|
| **`feedback_tickets`** | `20260428200000_vtid_02047_unified_feedback_pipeline_init.sql` | **Unified inbox for all user-originated signals** (bugs, UX, support, account, marketplace, feature requests, feedback). | **PRIMARY TARGET of this cleanup.** |
| `user_feedback_reports` | `20260227100000_user_feedback_reports.sql` | Legacy voice-dictated bug/UX reports from the Wellness Diary screen. Superseded by `feedback_tickets`. | Secondary; smaller status enum. Covered as a footnote. |
| `feedback-correction` route (`/api/v1/feedback`, VTID-01121) | n/a (trust-repair) | Match-quality / personalization correction signal — **NOT a ticket store.** | Out of scope. |
| `match_feedback` (VTID-01094) | `20251231000001_...match_feedback_loop.sql` | Matchmaking quality loop. | Out of scope. |

> Naming hazard noted in `services/gateway/src/index.ts:1158`: `/api/v1/feedback` is the
> VTID-01121 correction router; the ticket inbox is mounted at `/api/v1/feedback/tickets`.
> Do not confuse them.

This report concerns **`feedback_tickets`** (the canonical inbox).

---

## 2. Schema of `feedback_tickets` (the canonical store)

### Status enum (state ladder)

```
new → interviewing → triaged
    → spec_pending → spec_ready
    → answer_pending → answer_ready
    → approved → in_progress → resolved → user_confirmed
Branches: duplicate | rejected | wont_fix | needs_more_info | reopened
```

### Key columns for triage / dedupe

| Column | Type | Cleanup use |
|--------|------|-------------|
| `id` | UUID PK | identity |
| `ticket_number` | TEXT `FB-YYYY-MM-NNNNNN` | human-facing id (trigger-assigned) |
| `user_id` | UUID | reporter; classifier dedupe is **per-user** |
| `kind` | TEXT enum | bug / ux_issue / support_question / account_issue / marketplace_claim / feature_request / feedback |
| `status` | TEXT enum | lifecycle (above) |
| `priority` | TEXT | p0–p3 |
| `raw_transcript` | TEXT | **dedupe key** (normalized: `lower(trim(...))`) |
| `embedding` | vector(1536) | semantic dedupe (worker not yet wired — exact-match only today) |
| `duplicate_of` | UUID → self | canonical link when `status='duplicate'` |
| `similar_ticket_ids` | UUID[] | classifier-populated similarity set |
| `classifier_meta` | JSONB | `NULL` until classifier runs; holds confidence/keyword |
| `created_at` | TIMESTAMPTZ | age / stale calc |
| `triaged_at` / `resolved_at` / `user_confirmed_at` | TIMESTAMPTZ | activity timestamps |
| `linked_vtid` / `linked_pr_url` | TEXT | execution linkage |
| `assigned_to` / `supervisor_notes` | UUID / TEXT | supervisor |

> **Note:** there is no `updated_at` on `feedback_tickets`. "Last activity" must be
> derived as `GREATEST(created_at, triaged_at, resolved_at, user_confirmed_at)` —
> see SQL in §7. (`user_feedback_reports` *does* have `updated_at`.)

### Terminal vs open statuses

- **Terminal (closed):** `resolved`, `user_confirmed`, `rejected`, `wont_fix`, `duplicate`
  (matches the partial-index predicate in the migration, plus `user_confirmed`).
- **Open (actionable):** everything else.

---

## 3. Existing dedupe + close automation (do not duplicate)

The pipeline **already** has automation. This cleanup lane should *defer to it* and only
recommend transitions for cases it does **not** cover.

| Routine | Migration | What it does |
|---------|-----------|--------------|
| `classify_pending_feedback_tickets()` | `..._vtid_02604_feedback_classifier.sql` | pg_cron every 5 min. Sets kind/priority/surface; **exact normalized-transcript dedupe** (same user, open status, < 24h) → sets `status='duplicate'` + `duplicate_of`. |
| `auto_triage_pending_feedback_tickets()` | `..._vtid_02047_auto_triage.sql` | pg_cron every 5 min. Drafts answers/specs for high-confidence `triaged` tickets. Never closes. |
| Autonomous close + `playwright_verified` | `..._vtid_02669_feedback_autonomous_close.sql` | Stamps verified-fix flag; supervisor still confirms. |

**Implication for cleanup:** the classifier only dedupes *exact text within 24h, same
user*. It will **miss**: cross-user duplicates, near-duplicates (typos / rephrasing),
and exact-text duplicates older than 24h. Those are the gaps this lane surfaces.

---

## 4. Supervisor transition API (the only allowed write path)

All status moves go through `services/gateway/src/routes/feedback-actions.ts` (admin
router, mounted at `/api/v1/admin/feedback`). **No worker writes the table directly** —
this is the governed path the runbook and script use.

| Endpoint | Effect | Guard |
|----------|--------|-------|
| `POST /tickets/:id/mark-duplicate` `{duplicate_of}` | `status='duplicate'`, links canonical | duplicate_of must be valid UUID |
| `POST /tickets/:id/reject` `{reason?}` | `status='rejected'`, writes `supervisor_notes` | — |
| `POST /tickets/:id/resolve` | `status='resolved'`, sets `resolved_at` | — |
| `POST /tickets/:id/send-answer` | `status='resolved'` | only from `answer_ready` |
| `POST /tickets/:id/approve` | `status='in_progress'` | only from `spec_ready`/`answer_ready` |

There is **no delete endpoint** — by design. Cleanup is transition-only, which matches
this lane's constraint.

> **Gap:** there is no `wont_fix` endpoint in the admin router today (the enum supports
> it, but only `reject` is wired). Recommendation: treat `wont_fix` candidates as
> `reject` with a `reason` that begins `WONT_FIX:` until a dedicated endpoint exists,
> OR add a `wont_fix` action in a follow-up. See Risks.

---

## 5. Inventory (counts by status)

> **Live DB access was not available to this lane** (Supabase MCP read denied; this is a
> read-only analysis lane with no prod credentials). The counts below are produced by
> the operator running the **read-only** query in §7 against the dev Supabase project,
> or automatically by the script in `scripts/cleanup/` when given a service-role key.

Fill in after running §7 Query A:

| Status | Count |
|--------|-------|
| new | _TBD_ |
| interviewing | _TBD_ |
| triaged | _TBD_ |
| spec_pending / spec_ready | _TBD_ |
| answer_pending / answer_ready | _TBD_ |
| approved | _TBD_ |
| in_progress | _TBD_ |
| resolved | _TBD_ |
| user_confirmed | _TBD_ |
| duplicate | _TBD_ |
| rejected | _TBD_ |
| wont_fix | _TBD_ |
| needs_more_info | _TBD_ |
| reopened | _TBD_ |
| **TOTAL** | _TBD_ |

---

## 6. Cleanup candidate classes (rules, not deletions)

The script and runbook operate on these four **conservative** classes. Each maps to a
single allowed transition. Defaults are intentionally narrow to be safe.

### Class A — Exact-text duplicates the classifier missed
- **Detector:** two+ open tickets share `lower(trim(raw_transcript))` (any user, any age),
  and at least one is NOT already `status='duplicate'`.
- **Canonical:** oldest `created_at` in the cluster (stable, first-reported wins).
- **Recommended transition:** non-canonical members → **`mark-duplicate`** linked to canonical.
- **Safety:** never touches the canonical; never touches already-terminal tickets.

### Class B — Near-duplicate clusters (manual confirm)
- **Detector:** high token-overlap (trigram / Jaccard ≥ 0.85) on `raw_transcript` across
  open tickets, OR populated `similar_ticket_ids`.
- **Recommended transition:** **none auto** — surfaced as a review list only. Operator
  decides `mark-duplicate`. (Embedding worker not yet wired, so semantic match is
  approximate — kept manual on purpose.)

### Class C — Stale open tickets (no activity > N days)
- **N default:** 45 days (configurable). `last_activity` = `GREATEST(created_at, triaged_at, resolved_at, user_confirmed_at)`.
- **Sub-class C1 — stale `needs_more_info`:** reporter never replied. → recommend
  **`reject`** with `reason='WONT_FIX: stale — no reporter response in {N}d'`.
- **Sub-class C2 — stale low-priority `feature_request` / `feedback` (p3):** → surface for
  **`reject`** (`reason='WONT_FIX: backlog-aged p3'`), operator confirms.
- **Sub-class C3 — stale `new`/`triaged` real bugs/account issues:** → **DO NOT auto-close.**
  Surface as "needs attention" only. Closing real un-triaged bugs is unsafe.

### Class D — Already-resolved awaiting user confirmation
- **Detector:** `status='resolved'`, `resolved_at < NOW() - INTERVAL '14 days'`, never
  reopened.
- **Recommended transition:** **none** (already terminal). Informational only —
  flags tickets that could be moved to `user_confirmed` by a future auto-confirm flag.

> Safe reject/resolve candidates are **only** Class A (auto, low-risk) and the
> operator-confirmed subset of Class C1/C2. Everything else is report-only.

---

## 7. Read-only SQL inventory (DO NOT auto-run — operator runs against dev)

> Run in the Supabase SQL editor for the dev project or via psql with a read-only role.
> **All queries are SELECT-only.** Paste results into §5 / §6.

```sql
-- Query A: counts by status
SELECT status, count(*) AS n
FROM public.feedback_tickets
GROUP BY status
ORDER BY n DESC;

-- Query B: Class A — exact-text duplicate clusters among OPEN tickets
WITH norm AS (
  SELECT id, ticket_number, user_id, status, created_at,
         lower(trim(coalesce(raw_transcript,''))) AS k
  FROM public.feedback_tickets
  WHERE coalesce(raw_transcript,'') <> ''
    AND status NOT IN ('resolved','user_confirmed','rejected','wont_fix','duplicate')
),
clusters AS (
  SELECT k, count(*) AS n,
         min(created_at) AS first_seen,
         array_agg(id ORDER BY created_at) AS ids,
         array_agg(ticket_number ORDER BY created_at) AS numbers
  FROM norm GROUP BY k HAVING count(*) > 1
)
SELECT n, first_seen, numbers,
       ids[1] AS canonical_id,            -- oldest = canonical
       ids[2:array_length(ids,1)] AS duplicate_ids
FROM clusters
ORDER BY n DESC, first_seen ASC;

-- Query C: stale open tickets (no activity > N days; set N below)
WITH params AS (SELECT 45 AS stale_days)
SELECT t.ticket_number, t.kind, t.priority, t.status,
       GREATEST(t.created_at,
                coalesce(t.triaged_at, t.created_at),
                coalesce(t.resolved_at, t.created_at),
                coalesce(t.user_confirmed_at, t.created_at)) AS last_activity,
       now() - GREATEST(t.created_at,
                coalesce(t.triaged_at, t.created_at),
                coalesce(t.resolved_at, t.created_at),
                coalesce(t.user_confirmed_at, t.created_at)) AS idle
FROM public.feedback_tickets t, params p
WHERE t.status NOT IN ('resolved','user_confirmed','rejected','wont_fix','duplicate')
  AND GREATEST(t.created_at,
               coalesce(t.triaged_at, t.created_at),
               coalesce(t.resolved_at, t.created_at),
               coalesce(t.user_confirmed_at, t.created_at))
      < now() - make_interval(days => p.stale_days)
ORDER BY last_activity ASC;

-- Query D: near-duplicate candidates via trigram similarity (needs pg_trgm)
-- Review-only; do NOT auto-act on these.
SELECT a.ticket_number AS a, b.ticket_number AS b,
       round(similarity(a.raw_transcript, b.raw_transcript)::numeric, 3) AS sim
FROM public.feedback_tickets a
JOIN public.feedback_tickets b
  ON a.id < b.id
 AND a.status NOT IN ('resolved','user_confirmed','rejected','wont_fix','duplicate')
 AND b.status NOT IN ('resolved','user_confirmed','rejected','wont_fix','duplicate')
 AND a.raw_transcript % b.raw_transcript          -- pg_trgm operator
WHERE similarity(a.raw_transcript, b.raw_transcript) >= 0.85
ORDER BY sim DESC;
```

---

## 8. Recommended action summary

| Class | Volume | Transition | Auto-safe? | Tooling |
|-------|--------|-----------|-----------|---------|
| A — exact dupes missed by classifier | Query B | `mark-duplicate` → oldest | **Yes** | script `--class A` |
| B — near-dupes | Query D | `mark-duplicate` (manual) | No | report-only |
| C1 — stale `needs_more_info` | Query C | `reject` (`WONT_FIX:` reason) | **Yes (confirm)** | script `--class C1` |
| C2 — stale p3 backlog | Query C | `reject` (`WONT_FIX:` reason) | manual confirm | script `--class C2` |
| C3 — stale real bugs | Query C | none — escalate | No | report-only |
| D — old resolved | Query D' | none — informational | No | report-only |

See `feedback-cleanup-runbook.md` for operator steps and the dry-run script.

---

## Appendix — `user_feedback_reports` (legacy, secondary)

Smaller enum: `received | under_review | in_progress | fixed | wont_fix | duplicate`.
Has `updated_at`. Same approach applies but it is being superseded by `feedback_tickets`;
recommend leaving it alone except for obvious exact-text dupes. No transition endpoint is
wired for it in the gateway — transitions would need a service-role update. Out of scope
for the automated script; documented here for completeness.
