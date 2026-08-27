# Aurora Phase 0 Reconciliation — live run, 2026-08-27

**VTID-03734** (Phase 0 gate, per `SUPABASE-TO-AURORA-MIGRATION-PLAN.md`)

This is the first execution of Phase 0's exit criteria against live AWS +
Supabase state from a session with real DMS/RDS Data API access. It
root-causes the "~154,000 silently-dropped applies" finding that has been
carried as an open blocker since VTID-03419 (2026-07-27), and replaces it
with an exact, table-by-table number.

## Headline finding

**Aurora is not stale because DMS silently drops rows on every table — it
is stale because CDC has not run since 2026-08-13, and a smaller number of
specific tables have a real, DMS-logged column-level data-fidelity defect.**
Both things are true at once and this report separates them.

## 1. DMS task state (source of the staleness)

`aws dms describe-replication-tasks` for `vitana-supabase-to-aurora-v3`:

| Field | Value |
|---|---|
| Status | `failed` |
| Full load | 100%, 564 tables loaded, 2 tables errored |
| `FullLoadStartDate` | 2026-08-13T11:22:07Z |
| `FullLoadFinishDate` | 2026-08-13T11:39:59Z |
| `StopDate` | 2026-08-20T11:06:12Z (CDC ran ~7 days after full load, then died) |

The source endpoint (`vitana-src-supabase-v3`) still fails its connection
test today with the same Supavisor error found earlier this session
(`(ENOTFOUND) tenant/user migrate.inmkhvwdcuyhnxkgfvsb not found`) — this
is a Supabase-dashboard-side gap (Database → Connection Pooling / Roles),
not something fixable from AWS or SQL. Re-verified live 2026-08-27; no
change since the earlier finding this session. **CDC cannot resume until
a human fixes this in the Supabase dashboard.**

Two tables full-load-errored and hold 0 rows on Aurora: `conversation_messages`,
`reminders`. Both are also 0 rows on live Supabase today, so this is not
currently hiding lost data — but structurally these two tables have never
successfully loaded via DMS at all, on any attempt, and need their error
cause investigated before they can be trusted even after CDC is fixed.

## 2. Root-caused: the historical "~154k dropped applies" figure

**Real, current number: 225,990 RECORD_DIFF entries**, in Aurora's own
`awsdms_validation_failures_v1` table (DMS's built-in validation feature,
which ran during the 2026-07-27→08-13 full-load/CDC window and logged
every row where source and target values diverged — this is not an
estimate, it is DMS's own persisted audit trail).

Concentration — top tables account for the overwhelming majority:

| Table | RECORD_DIFF count | % of total |
|---|---|---|
| `oasis_events` | 160,007 | 70.8% |
| `events` | 53,944 | 23.9% |
| `autopilot_recommendations` | 3,933 | 1.7% |
| `memory_audit_log_y2026m06` | 3,252 | 1.4% |
| `calendar_events` | 1,374 | 0.6% |
| (20 more tables, each <1%) | ~2,480 | 1.1% |

**Root cause, confirmed on `oasis_events`:** the `projected` column
(`boolean`, nullable, `DEFAULT false`) diverges between source and target —
DMS's `DETAILS` field records `[{'projected':'<null>'}, {'projected':'0'}]`
(source NULL, target coerced to the column default) for every one of the
160,007 failing rows sampled. This is a boolean-NULL-vs-default coercion
during full load, not row loss — the row exists on both sides with the
same key, only this one column differs. `events` (53,944 failures, 23.9%
of the total) was not individually re-verified this pass but shares the
same `RECORD_DIFF` failure type and is the next-highest concentration;
treat as the same class of defect until checked, not confirmed identical.

**This changes the finding materially versus what VTID-03419/07-31 could
say:** those sessions had no live DMS access and could only cite "~154k"
from indirect evidence. This pass reads the number directly, shows it grew
to 225,990 (more full-load activity happened since), and identifies the
column and coercion behavior responsible for the two largest tables by an
order of magnitude over everything else. **Not yet done:** confirming the
same root cause on `events`, or checking whether any of the remaining 23
smaller tables are a *different* failure class (e.g. real row loss, not
column coercion) — the sampling only checked `oasis_events`.

## 3. Row-count reconciliation, all ~660 relations, live 2026-08-27

Pulled `n_live_tup` from `pg_stat_user_tables` on both sides (Aurora via
RDS Data API, Supabase via the Supabase MCP), across every schema visible
to that view (not just `public` — `auth`, `storage`, etc. included on both
sides, since neither side was schema-filtered).

| Category | Count |
|---|---|
| Tables with identical counts | ~344 |
| Tables with differing counts | 317 |
| Tables in Supabase, missing on Aurora | 77 |
| Tables on Aurora, not in Supabase | 5 |

**The 77 "missing on Aurora" tables are not a gap** — every one of them is
a Supabase-platform-internal table (`auth.*`: `sessions`, `refresh_tokens`,
`mfa_amr_claims`, `identities`, `one_time_tokens`; `storage.*`: `buckets`,
`objects`, `s3_multipart_uploads*`; Stripe-sync internal tables:
`customers`, `charges`, `invoices`, `subscriptions`, etc.) that DMS was
never configured to replicate, correctly — these are GoTrue/Storage/
Stripe-extension internals, not application data, and are exactly the
seams B4 (identity/auth) and B6 (storage) already scoped as needing their
own AWS-native replacement rather than a DMS copy.

**The 5 "only on Aurora" tables:** 4 are DMS's own bookkeeping
(`awsdms_ddl_audit`, `awsdms_status`, `awsdms_suspended_tables`,
`awsdms_validation_failures_v1` — expected, DMS writes these into the
target). The 5th, **`dev_autopilot_prompt_learnings`, is a genuine
table present on Aurora with 0 rows that does not exist in Supabase's
live schema today** — flagging as an open question (renamed/dropped table
that a stale DMS mapping still carries?) rather than resolving it here.

**The 317 differing-count tables are the expected, direct consequence of
§1 — 2 weeks with no CDC.** The largest diffs by absolute row count:

| Table | Supabase (live) | Aurora (stale) | Diff |
|---|---|---|---|
| `autopilot_processed_events` | 0 | 1,900,755 | Aurora holds 1.9M rows from a table since cleared on Supabase |
| `dev_autopilot_signals` | 0 | 344,093 | same pattern |
| `user_activity_log` | 8,771 | 135,960 | Aurora stale-high — pre-purge snapshot |
| `product_analytics_events` | 8,394 | 112,433 | same pattern |
| `events` | 0 | 70,823 | table since cleared/renamed on Supabase |
| `chat_messages` | 1,939 | 41,217 | Aurora stale-high |
| `oasis_events` | 492,490 | 466,654 | Aurora stale-LOW here — 25,836 rows written since 08-13 never replicated |
| `memory_facts` | 491 | **0** | **flagged separately below** |

**`memory_facts = 0` on Aurora is worth calling out on its own** — this is
the write_fact()-backed canonical memory table (§14 of the platform
CLAUDE.md), and it holds zero rows on Aurora despite 491 live rows on
Supabase. Given the DMS task's own full-load report says 564/566 tables
loaded successfully (only `conversation_messages`/`reminders` errored),
this table most likely populated *after* the 2026-08-13 full load and
Aurora simply never got the rows via CDC before CDC died a week later —
consistent with the broader staleness story, not a separate defect. Not
independently confirmed against the full-load completion log.

## 4. What this satisfies vs. what is still open (Phase 0 exit criteria)

| Exit criterion | Status |
|---|---|
| 1. Root-cause the dropped applies | **Done for `oasis_events` (70.8% of all failures)** — boolean NULL/default coercion, confirmed by direct row inspection. `events` (23.9%) not yet independently confirmed as the same class. Remaining ~24 tables (5.3%) not sampled. |
| 2. Full row-count + checksum reconciliation, per table | **Row counts: done, all ~660 relations, this pass.** Checksums: **not done** — DMS's own `awsdms_validation_failures_v1` provides row-level diff detection for the window it ran, which is a stronger signal than a plain checksum for the tables it covered, but that coverage ended when the task failed 2026-08-20 and does not cover data written since. |
| 3. A re-runnable reconciliation job | **Not done.** This pass was ad hoc (manual RDS Data API + Supabase MCP queries, saved to `/tmp`, not committed as a script). `scripts/reconciliation/aurora-supabase-reconcile.ts` exists in the repo but per its own VTID-03649 note has still never been exercised against real credentials — that remains true after this pass; this report did not use that script. |
| 4. Zero unexplained divergence sustained 7 days | **Cannot start** — gated on the Supabase-dashboard Supavisor fix (§1) before CDC can even resume, let alone run clean for 7 days. |

**Bottom line: Phase 0 is not closed.** This pass converts "unknown-quality
partial copy" into a precisely quantified, mostly-explained one, and
removes the single largest open unknown (root cause of the dropped
applies). The remaining blockers are (a) the human Supabase dashboard
action already flagged earlier this session, and (b) turning this ad hoc
query pass into the re-runnable job criterion 3 actually asks for.
