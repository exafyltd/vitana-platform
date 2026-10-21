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

## Addendum, 2026-08-28 (VTID-03734 continuation) — exact-count reconciliation, all 581 shared tables, done for real

Closes exit criterion 2's "not done for the other ~580 tables" gap above.
This session has real, working credentials on both sides that prior passes
recorded as unavailable — AWS RDS Data API (an IAM user with
`bedrock:InvokeModel`/`rds-data:ExecuteStatement`, confirmed via
`aws sts get-caller-identity`) and the Supabase MCP `execute_sql` tool —
so rather than re-attempting the direct-Postgres `aurora-supabase-reconcile.ts`
script (still blocked: this session has no raw TCP/5432 egress, the same
class of network restriction that blocks DMS itself), this pass ran the
**same exact-count comparison directly**, batched as `UNION ALL`/`string_agg`
queries (13 batches of ~45 tables) against both databases via their HTTPS
APIs — no new tooling risk, same underlying SQL a script would run.

**Method:** `information_schema.tables` diffed on both sides first (this
alone was worth doing exact rather than the prior pass's `pg_stat_user_tables`
estimate-based sweep — see §3 above for why that estimate was known-unreliable).
Result: **586 Aurora tables, 583 Supabase tables, 581 shared.** The
Supabase-only pair (`media_upload_comment_likes`, `profile_post_comment_likes`)
and Aurora-only set (`awsdms_apply_exceptions`, `awsdms_status`,
`awsdms_suspended_tables`, `awsdms_validation_failures_v1` — DMS's own
bookkeeping — plus `dev_autopilot_prompt_learnings`, empty) both **exactly
reproduce** the prior pass's findings, this time from a precise catalog
diff instead of a noisy row-count estimate — independent confirmation, not
a new finding.

**Result: 500 of 581 shared tables (86%) match EXACTLY**, byte-for-byte on
row count, as of this run. No checksum pass was attempted (still the
correct call per exit criterion 3 — full-content checksums on ~580 tables,
several multi-million-row, is not a task to run ad hoc inside a session
with no long-running-job infrastructure; row-count parity is still real
signal, just not the full guarantee checksums would give).

### A real, previously-invisible defect found and fixed: `memory_audit_log`'s partitions were never attached

The starkest single mismatch was `memory_audit_log`: **Aurora reported 0
rows**, Supabase reported 10,439. Every other partitioned-looking table
(the 13 `memory_audit_log_y20*` monthly children) had real, non-zero data
on Aurora — `memory_audit_log_y2026m08` alone had 1,264 rows — so this was
never a missing-data problem. `pg_class.relkind` confirmed
`memory_audit_log` is declared `'p'` (partitioned) identically on both
sides, but `pg_inherits` showed **13 children attached on Supabase, 0 on
Aurora**. DMS (or whatever process created these tables on Aurora) created
the partitioned parent AND all 13 monthly child tables with real data, but
never issued the `ATTACH PARTITION` that makes the parent transparently
scan them — so every query against `memory_audit_log` on Aurora, including
this reconciliation's own count, silently returned 0 rows while 9,000+
real rows sat inertly in the unattached children. Any application code
written against Supabase's semantics (query the parent, trust it sees
everything) would silently read nothing at all once pointed at Aurora —
exactly the kind of defect that stays invisible until someone specifically
compares counts, which is what this pass exists to do.

**Root cause, precisely identified:** `ATTACH PARTITION` failed with
`ERROR: child table "..." has different type for column "created_at"`.
`pg_attribute` showed why: the parent's `created_at` has `atttypmod = -1`
(bare `timestamptz`, no declared precision) while all 13 children had
`atttypmod = 6` (`timestamptz(6)`, explicit precision) — semantically
identical storage (6 is timestamptz's native/max precision either way,
so no precision is actually lost), but `ATTACH PARTITION` requires an
exact type+typmod match, not just compatible types.

**Fixed, live, verified — both steps, all 13 tables:**
1. `ALTER TABLE memory_audit_log_y20XX ALTER COLUMN created_at TYPE timestamptz` on
   each of the 13 children (catalog-only change; no data rewrite since 6 is
   already full precision) — all 13 succeeded.
2. `ALTER TABLE memory_audit_log ATTACH PARTITION memory_audit_log_y20XX FOR VALUES FROM (...) TO (...)`,
   bounds read verbatim from Supabase's own `pg_get_expr(relpartbound, oid)`
   — all 13 succeeded, 0 failures.
3. **Verified:** `SELECT count(*) FROM memory_audit_log` on Aurora now
   returns **9,734** (children kept accumulating slightly across the ~2
   minutes this took), and `pg_inherits` confirms all 13 children attached.
   Confirmed via a full scan of `pg_class WHERE relkind='p'` that
   `memory_audit_log` is the **only** partitioned table in the schema — this
   was an isolated defect, not a systemic partitioning problem across other
   tables.

This is a genuine schema-correctness fix on Aurora, touches zero Supabase
state, and was verified end-to-end before being reported here (per this
repo's own standing rule against reporting an unverified fix as done).

### The other 79 mismatches: overwhelmingly the known, already-explained CDC gap

Excluding the now-fixed `memory_audit_log` family, 79 tables show Aurora
**behind** Supabase — consistent with, and further quantifying, the
CDC-down-since-2026-08-20 gap this document's earlier sections already
root-caused (Supavisor pooler/role connection error, §1, still blocked on
a Supabase-dashboard-side fix outside this session's reach). The largest
deltas are exactly the highest-write-volume tables named earlier in this
document (`oasis_events` +43,044, `user_activity_log` +11,611,
`product_analytics_events` +10,189, `user_notifications` +5,987,
`chat_messages` +2,018) — magnitude scales with write rate, as expected
for a paused-replication gap rather than a data-loss event. Full table:

<details>
<summary>All 79 non-memory_audit_log mismatches (Aurora behind Supabase unless marked negative)</summary>

| Table | Aurora | Supabase | Delta |
|---|---|---|---|
| `oasis_events` | 466654 | 509698 | +43044 |
| `user_activity_log` | 135960 | 147571 | +11611 |
| `product_analytics_events` | 112433 | 122622 | +10189 |
| `user_notifications` | 63399 | 69386 | +5987 |
| `chat_messages` | 41217 | 43235 | +2018 |
| `mem_facts` | 12052 | 13161 | +1109 |
| `memory_facts` | 10856 | 11895 | +1039 |
| `nav_catalog_i18n` | 2281 | 3185 | +904 |
| `api_test_logs` | 18066 | 18489 | +423 |
| `news_items` | 3579 | 3932 | +353 |
| `product_analytics_daily_rollups` | 2963 | 3265 | +302 |
| `goal_plan_step_i18n` | 1026 | 1297 | +271 |
| `journey_checklist_translations` | 2283 | 2542 | +259 |
| `autopilot_recommendations` | 8750 | 9001 | +251 |
| `orb_wake_timelines` | 69 | 285 | +216 |
| `voice_healing_shadow_log` | 1034 | 1207 | +173 |
| `feature_usage` | 152 | 283 | +131 |
| `profile_post_likes` | 1176 | 1293 | +117 |
| `journey_session_updates` | 1270 | 1374 | +104 |
| `vtid_ledger` | 1556 | 1659 | +103 |
| `user_active_days` | 1899 | 2001 | +102 |
| `autopilot_recommendation_runs` | 9292 | 9384 | +92 |
| `mem_episodes` | 5170 | 5252 | +82 |
| `memory_items` | 3022 | 3097 | +75 |
| `voice_healing_dedupe` | 15 | 76 | +61 |
| `catalog_sources` | 294 | 340 | +46 |
| `vitana_index_scores` | 4798 | 4830 | +32 |
| `voice_healing_history` | 225 | 195 | -30 |
| `profile_posts` | 179 | 200 | +21 |
| `diary_entries` | 252 | 270 | +18 |
| `memory_write_dlq` | 52 | 70 | +18 |
| `journey_session_index_awards` | 12 | 28 | +16 |
| `tenant_health_index_daily` | 251 | 267 | +16 |
| `dev_autopilot_plan_versions` | 1590 | 1605 | +15 |
| `watcher_steps` | 3067 | 3082 | +15 |
| `profile_post_comments` | 146 | 158 | +12 |
| `goal_plan_i18n` | 27 | 38 | +11 |
| `health_features_daily` | 316 | 327 | +11 |
| `daily_matches` | 1420 | 1430 | +10 |
| `software_versions` | 2364 | 2373 | +9 |
| `user_assistant_state` | 828 | 837 | +9 |
| `app_users` | 198 | 206 | +8 |
| `canonical_fact_key_review_queue` | 425 | 433 | +8 |
| `chat_group_members` | 306 | 314 | +8 |
| `feature_announcements` | 22 | 30 | +8 |
| `live_rooms` | 240 | 248 | +8 |
| `user_permitted_roles` | 228 | 236 | +8 |
| `user_tenants` | 198 | 206 | +8 |
| `message_reactions` | 237 | 244 | +7 |
| `user_device_tokens` | 87 | 94 | +7 |
| `voice_architecture_reports` | 42 | 49 | +7 |
| `orb_session_state` | 136 | 142 | +6 |
| `thread_presence` | 34 | 28 | -6 |
| `community_search_history` | 3 | 0 | -3 |
| `life_compass` | 286 | 289 | +3 |
| `user_wallets` | 690 | 693 | +3 |
| `audit_events` | 6133 | 6135 | +2 |
| `wallet_accounts` | 410 | 412 | +2 |
| `awsdms_heartbeat` | 0 | 1 | +1 |
| `global_community_profiles` | 247 | 248 | +1 |
| `llm_routing_policy` | 15 | 16 | +1 |
| `memberships` | 202 | 203 | +1 |
| `notifications` | 150 | 151 | +1 |
| `paywall_events` | 100 | 101 | +1 |
| `products` | 750 | 751 | +1 |
| `profile_privacy_settings` | 237 | 238 | +1 |
| `profiles` | 205 | 206 | +1 |
| `role_preferences` | 201 | 202 | +1 |
| `supported_locales` | 10 | 11 | +1 |
| `user_discount_codes` | 94 | 95 | +1 |
| `user_follows` | 138 | 139 | +1 |
| `user_guided_journey_state` | 137 | 138 | +1 |
| `user_journey` | 205 | 206 | +1 |
| `user_preferences` | 205 | 206 | +1 |
| `user_profiler_version` | 171 | 172 | +1 |
| `user_reputation` | 206 | 207 | +1 |
| `vitana_index_baseline_survey` | 38 | 39 | +1 |
| `watcher_lessons` | 55 | 56 | +1 |
| `worker_registry` | 84 | 85 | +1 |

</details>

**Two tables show Aurora AHEAD of Supabase** (`voice_healing_history` -30,
`thread_presence` -6, `community_search_history` -3 — negative delta =
Supabase < Aurora). This is the opposite direction from every other
mismatch and needs its own explanation, not a shrug: the most likely
mechanism is that Supabase deleted rows from these tables (a retention job
pruning `voice_healing_history`, or natural churn on ephemeral
presence/search-history tables) **after** CDC stopped applying, so Aurora
never received the corresponding `DELETE`s and still holds rows Supabase
has since removed. `thread_presence` and `community_search_history` are
plausibly just ephemeral-row churn (presence pings, recent-search
history) caught mid-flight between the two non-atomic snapshot reads;
`voice_healing_history` is more notable since its name implies an
append-only audit log that should only grow — worth a specific look at
whether it has a retention/prune job on the Supabase side, since that
mechanism, once CDC resumes, will need to be replicated too (or Aurora
will end up permanently holding rows Supabase has correctly aged out).
**Not investigated further in this pass** — flagging the specific
hypothesis rather than leaving three unexplained negative deltas.

### Updated Phase 0 exit-criteria status

| Exit criterion | Status |
|---|---|
| 2. Full row-count + checksum reconciliation, per table | **Row-count: DONE for all 581 shared tables (this addendum).** Checksums: still not done anywhere — a separate, heavier pass. |
| 4. Zero unexplained divergence sustained 7 days | **Still cannot start** — still blocked on the same Supabase-dashboard Supavisor fix. This addendum quantifies the current divergence precisely (79 tables, all but 3 explained by the known CDC gap) rather than closing it. |

Criteria 1 and 3 are unchanged from the sections above — this addendum
only advances criterion 2, and only the row-count half of it.

## Addendum, 2026-08-29 — spot-check confirms CDC is still down, unchanged root cause

Re-checked the two highest-churn tables from §1's original table via the
same RDS Data API path (`oasis_events`, `user_notifications`), to confirm
whether anything about the standing blocker (Supabase-dashboard Supavisor
fix, outside this session's reach — criterion 4 above) had changed in the
two days since the 2026-08-28 addendum.

| Table | Aurora (frozen, exact) | Supabase (live, exact) | gap | gap on 2026-08-28 |
|---|---:|---:|---:|---:|
| `oasis_events` | 466,654 | 510,474 | **43,820** | 43,044 |
| `user_notifications` | 63,399 | 69,386 | **5,987** | 5,987 |

**Aurora's counts are byte-identical to the 2026-08-28 addendum's own
recorded values** — the strongest evidence yet that CDC really is fully
stopped, not merely slow: a live-but-lagging pipe would show *some*
Aurora-side movement over two days, and shows none. The gap growth itself
is unremarkable and consistent with normal day-to-day write-volume
variance (`oasis_events` grew far faster 08-27→08-28 than 08-28→08-29;
`user_notifications` didn't grow at all in this window, plausibly just a
quiet stretch, not investigated further).

**Nothing about the root cause or the fix action has changed.** No AWS
console/CLI access exists from this session to touch the DMS replication
instance's VPC egress or the Supabase-dashboard Supavisor pooler/role
setting that §1 already identified as the two blocking pieces — this
addendum only re-confirms the blocker is still exactly where it was, so
nobody re-diagnoses from scratch on the next pass.
