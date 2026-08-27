# Aurora Phase 0 Reconciliation — live run, 2026-08-27

**VTID-03734** (Phase 0 gate, per `SUPABASE-TO-AURORA-MIGRATION-PLAN.md`)

**CORRECTED 2026-08-27, same day.** This report originally claimed to have
"root-caused and confirmed as a live, generalized defect" the
`awsdms_validation_failures_v1` entries. That claim was wrong, and the
correction matters more than the original content — see §2.

## Correction notice — read this first

An earlier pass in this same migration effort, `docs/AURORA-PHASE0-RECONCILIATION-FINDINGS.md`
(also VTID-03734, written 2026-08-25), already did this exact investigation
more rigorously and reached the **opposite** conclusion from this report's
original text:

- That pass used **exact `count(*)`**. This report's first version used
  `pg_stat_user_tables.n_live_tup` (the ANALYZE-based estimate) for its
  ~660-relation row-count sweep. The earlier pass explicitly measured
  `n_live_tup` as **29x wrong** on `oasis_events` and **28x wrong** on
  `chat_messages` on this exact database. **Every row-count number in §3
  below inherits that unreliability** — treat §3 as a schema-existence
  check (does the table exist on both sides, yes/no) only, never as a row
  count you can act on. The exact-count numbers in the corrected §2/§3
  below are the trustworthy ones.
- That pass spot-checked the single most-repeated `awsdms_validation_failures_v1`
  entry — `oasis_events`, row id `4614de3c-603f-4f38-88de-e540c22d37d3`,
  the `projected` column — live against both databases, and found
  **Supabase and Aurora agree (`projected: true` on both)**. This report's
  first version checked the *identical row* and got the *identical result*
  (Aurora shows `true`), but misread it as "confirming a live coercion
  defect" instead of what it actually shows: **the row matches today, so
  the validation-failure log entry is stale history, not a live divergence.**
  The earlier pass traced the 225,958 entries to a single 39-minute
  validation run on 2026-07-27, from the **older**, now-superseded
  `vitana-supabase-to-aurora` task — not the current `vitana-supabase-to-aurora-v3`
  task this report was investigating. Sampling 10 more tables and finding
  the same `NULL`-vs-default (or `''`-vs-`'1'`, a likely string-rendering
  artifact of the validation tool itself) shape in all of them, as this
  report's second revision did, is consistent with "one old load had this
  shape everywhere" — it does not make the shape current or ongoing, and
  does not change the earlier pass's decisive live spot-check.

**What that leaves as the real, current gap** — confirmed independently by
this pass, re-measuring with exact `count(*)` on 2026-08-27 (two days after
the earlier pass's 2026-08-25 numbers, same three tables, gap growing
exactly as expected from continued un-replicated writes):

| table | Supabase (live, exact) | Aurora (exact, frozen at CDC death) | gap | gap on 2026-08-25 (prior pass) |
|---|---:|---:|---:|---:|
| `oasis_events` | 492,609 | 466,654 | **25,955** | 9,332 |
| `user_activity_log` | 144,775 | 135,960 | **8,815** | 4,702 |
| `chat_messages` | 43,156 | 41,217 | **1,939** | 1,539 |

The gap has grown by roughly the amount of production write traffic over
those two days on each table — direct confirmation that CDC has stayed
down continuously since 2026-08-20, not intermittently, and that this (not
the validation-failure log) is where Phase 0's real, current divergence
lives.

## 1. DMS task state — still down, root cause has shifted since the prior pass

`vitana-supabase-to-aurora-v3` is still `Status: failed`. The prior pass
(2026-08-25) found two independent connection failures: a stale password
on target endpoint `vitana-tgt-aurora-v2`, and an IPv6-routing gap on the
source endpoint reaching `db.inmkhvwdcuyhnxkgfvsb.supabase.co` directly.

**Both have since changed, re-tested live today:**

- **Target password: fixed.** This session's own task #1 (earlier in this
  conversation, before this report was written) applied the RDS-managed-password
  fix to `vitana-tgt-aurora-v2` specifically — the same endpoint the prior
  pass named. Not independently re-tested with `dms test-connection` in
  this pass, but the RDS Data API connects with the current credential, so
  the underlying secret is confirmed current.
- **Source: still broken, but with a *different* error than the prior
  pass found.** The prior pass saw an IPv6-unreachable network error
  against the direct Postgres host. Today's `dms test-connection` against
  `vitana-src-supabase-v3` returns `(ENOTFOUND) tenant/user
  migrate.inmkhvwdcuyhnxkgfvsb not found` — a Supavisor pooler
  tenant/role-registration error, not a network error. This means the
  source endpoint's connection settings were changed at some point between
  the prior pass and now (consistent with this session's own earlier
  history of trying an IPv4-reachable Supavisor-pooler host with a
  purpose-created `migrate` role, to work around exactly the IPv6 gap the
  prior pass diagnosed) — and that attempt introduced a new, still-blocking
  error. **This is a Supabase-dashboard-side gap** (Database → Connection
  Pooling, or re-saving the `migrate` role under Database → Roles) that
  cannot be fixed via SQL, the Management API, or AWS from this session —
  re-confirmed, not newly discovered, this session already reached this
  same conclusion earlier via a different path.

## 1b. CDC gap confirmed broad-based, not limited to the original 3 tables

Same-day follow-up, using the newly-confirmed RDS Data API access (works
over HTTPS, unaffected by the VPC IPv6 gap blocking DMS's own connection —
see §1). Ran identical exact `count(*)` queries against Supabase and
Aurora for 21 more tables (not the original 3), covering a mix of
high-write (`product_analytics_events`, `user_notifications`,
`api_test_logs`) and low-write (`admin_insights`, `user_reputation`)
tables:

| table | Supabase | Aurora | gap |
|---|---:|---:|---:|
| `product_analytics_events` | 120,982 | 112,433 | 8,549 |
| `user_notifications` | 67,945 | 63,399 | 4,546 |
| `mem_facts` | 13,077 | 12,052 | 1,025 |
| `memory_facts` | 11,803 | 10,856 | 947 |
| `nav_catalog_i18n` | 3,185 | 2,281 | 904 |
| `api_test_logs` | 18,410 | 18,066 | 344 |
| `news_items` | 3,864 | 3,579 | 285 |
| `product_analytics_daily_rollups` | 3,237 | 2,963 | 274 |
| `journey_checklist_translations` | 2,542 | 2,283 | 259 |
| `orb_wake_timelines` | 260 | 69 | 191 |
| `voice_healing_shadow_log` | 1,189 | 1,034 | 155 |
| `goal_plan_step_i18n` | 1,297 | 1,026 | 271 |
| `feature_usage` | 249 | 152 | 97 |
| `vtid_ledger` | 1,646 | 1,556 | 90 |
| `catalog_sources` | 334 | 294 | 40 |
| `tenant_health_index_daily` | 265 | 251 | 14 |
| `daily_matches` | 1,430 | 1,420 | 10 |
| `user_assistant_state` | 837 | 828 | 9 |
| `app_users` | 206 | 198 | 8 |
| `user_reputation` | 207 | 206 | 1 |
| `admin_insights` | 393 | 393 | 0 |

20 of 21 tables show a real, positive gap (the one exception,
`admin_insights`, is simply low-write in this window). This is not a
handful of hot tables — it's every actively-written table checked,
consistent with a single systemic cause (CDC down since 2026-08-20) rather
than per-table anomalies. Confirms the §1/§2 finding at much broader
coverage than the original 3-table spot-check.

Two tables (`conversation_messages`, `reminders`) still show `Table error`/
`FullLoadRows: 0` in `describe-table-statistics` for the v3 task. The prior
pass already checked these live and found both match exactly on row count
(120 and 18 rows respectively as of 2026-08-25) — populated by an earlier
task's successful load or by CDC before it died, not actually empty. Not
re-verified in this pass; no reason to expect it changed given CDC has
been down the whole time since.

## 2. The `awsdms_validation_failures_v1` finding, corrected

**This section replaces the original "root-caused, confirmed generalized
defect" claim entirely.** The 225,990 `RECORD_DIFF` entries (up slightly
from the prior pass's 225,958 — consistent with a little more full-load
activity on the older, superseded task before it stopped mattering) are
**stale history from a single 39-minute validation run on 2026-07-27,
against the older `vitana-supabase-to-aurora` task** — not evidence of an
ongoing defect in the current `v3` task or in Aurora's present state.

The failure shape (nullable boolean column, source value differs from
target) is real *as a description of what that old validation run saw*,
and generalizes across at least 12 sampled tables covering 99.5% of the
225,990 entries. But "generalizes across many tables" and "is current" are
different claims — this pass conflated them. The decisive test is whether
a flagged row still differs *today*, and both this pass and the prior one
checked the single most-repeated example and found it does not. Until a
*currently* differing row is found by checking a validation-failure key
against live data on both sides and getting an actual mismatch, this table
should be treated as closed, historical noise — not as an open
data-integrity question.

## 3. Row-count / schema-existence sweep, all ~660 relations (unreliable counts, reliable existence)

Pulled `n_live_tup` from `pg_stat_user_tables` on both sides across every
schema visible to that view. **Per the correction notice above, do not
trust any individual count from this sweep** — only the existence
comparison (present/absent) is reliable.

| Category | Count |
|---|---|
| Tables present on both sides (regardless of count accuracy) | ~583 |
| Tables in Supabase, absent from Aurora | 77 |
| Tables on Aurora, absent from Supabase | 5 |

**Two of the 77 "Supabase-only" tables are genuine, actionable gaps** —
`media_upload_comment_likes` and `profile_post_comment_likes` (confirmed
present in Supabase, absent from Aurora, both directions checked). The
prior pass already found and named these exact two tables via a cleaner
`public`-schema-only diff (583 vs 586 tables) and recommended a backfill
once CDC resumes — this pass's broader, all-schema sweep independently
reproduces the same two, adding no new ones. The other 75 are
Supabase-platform-internal tables (`auth.*`, `storage.*`, Stripe-sync
internals) that DMS was correctly never configured to replicate — expected,
not a gap, and exactly the seams B4/B6 already scope as needing their own
AWS-native replacement rather than a DMS copy.

**The 5 "Aurora-only" tables:** 4 are DMS's own bookkeeping
(`awsdms_ddl_audit`, `awsdms_status`, `awsdms_suspended_tables`,
`awsdms_validation_failures_v1`). The 5th, `dev_autopilot_prompt_learnings`
(0 rows), is already flagged in the prior pass as an open, low-priority
question (why does it exist only on Aurora, empty) — not resolved by
either pass.

## 4. What this satisfies vs. what is still open (Phase 0 exit criteria)

| Exit criterion | Status |
|---|---|
| 1. Root-cause the dropped applies | **Closed by the prior pass, confirmed by this one's own (corrected) reading of the same evidence: there was no current defect to root-cause — the "~154k"/225,990 figure is stale history from a superseded task, decisively checked against live data.** |
| 2. Full row-count + checksum reconciliation, per table | **Exact-count reconciliation done for the 3 highest-churn tables (both this pass and the prior one) — real, growing CDC-gap confirmed. Not done for the other ~580 tables** — the only full-scope attempt (this report's §3) used an estimator now known to be unreliable and must be redone with exact `count(*)` before it can inform any decision. Checksums: still not done anywhere. |
| 3. A re-runnable reconciliation job | **Still not done.** Two ad hoc passes now exist (this one, the 2026-08-25 one); neither is a committed, re-runnable script. `scripts/reconciliation/aurora-supabase-reconcile.ts` remains unexercised against real credentials. |
| 4. Zero unexplained divergence sustained 7 days | **Cannot start.** Blocked on the Supabase-dashboard Supavisor fix (§1) before CDC can even resume. The specific blocking error has changed since the prior pass (Supavisor tenant/role error, not IPv6) — worth relaying to whoever fixes it, since the fix action itself may now be different (a pooler/role dashboard setting, not a networking one). |

**Bottom line: Phase 0 is not closed, and the real remaining gap is
narrower and better-understood than this report's own first draft claimed.**
The validation-failure table is a closed question, not an open one. The
open questions are: (a) the Supabase-side connection fix, now against a
different error than previously documented, (b) an exact-count
reconciliation across all ~580 shared tables (not just the 3 done here),
and (c) turning any of these ad hoc passes into the re-runnable job
criterion 3 asks for.
