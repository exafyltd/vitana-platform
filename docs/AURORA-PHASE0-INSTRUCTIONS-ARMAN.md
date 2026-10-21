# Phase 0 — Aurora data-integrity verification

**For: @arman** · VTID-03494 · 2026-08-04

You have live AWS/DMS access; no Claude session has. This document is the
critical path — **every other part of the Supabase→Aurora migration is blocked
until this is closed.**

## Why you are being asked

VTID-03419 (2026-07-27) tried to include Aurora-dependent services in the
GCP→AWS cutover and pulled them back out, because DMS reported roughly
**154,000 silently-dropped row applies**. "Silently" is the important word — DMS
did not error, it recorded the applies as dropped and continued. The finding was
reopened on 2026-07-31 and has never been root-caused.

So today Aurora holds a copy of production of **unknown quality**. Migrating the
platform onto it would promote whatever is missing to primary, permanently and
invisibly.

Your job is to answer one question: **does Aurora actually match Supabase, and
if not, exactly where does it diverge?**

---

## Environment

| | |
|---|---|
| AWS account / region | `472838866351` / `eu-central-1` |
| Aurora cluster | `vitana-aurora-prod` (writer + reader) |
| Supabase project (source of truth) | `inmkhvwdcuyhnxkgfvsb` |
| Expected public tables | **510** as of 2026-08-04 |

Note: Supabase is only reachable over the pooler from an allow-listed IP —
GitHub Actions runners are **not** on the allow-list (this is what
VTID-03492 fixed for CI). Run these from a machine that *is* allow-listed, or
add your IP first.

---

## Step 1 — DMS task state and the dropped-row detail

```bash
aws dms describe-replication-tasks --region eu-central-1 \
  --query 'ReplicationTasks[].{Id:ReplicationTaskIdentifier,Status:Status,Stats:ReplicationTaskStats}'
```

Then, per task, the thing that actually matters:

```bash
aws dms describe-table-statistics --region eu-central-1 \
  --replication-task-arn <TASK_ARN> \
  --query 'TableStatistics[?ValidationFailedRecords>`0`||AppliesDropped>`0`].
           {Schema:SchemaName,Table:TableName,Dropped:AppliesDropped,
            ValFail:ValidationFailedRecords,ValState:ValidationState,
            Ins:Inserts,Upd:Updates,Del:Deletes}' \
  --output table
```

**Capture the full output verbatim** — this is the first time anyone will have
the per-table breakdown. Please attach it to the PR or paste it back.

What we need from it:
1. **Which tables** the ~154k drops are concentrated in.
2. Whether `ValidationState` is `Validated` / `Mismatched` / `Suspended` /
   `Pending records` per table.
3. Whether drops are still **accruing** or are historical.

## Step 2 — Independent row-count reconciliation

Do not trust DMS's own stats alone — the whole problem is that DMS under-reported.
Count both sides independently.

On **Supabase** (allow-listed host):
```bash
psql "$SUPABASE_DB_URL" -t -A -F',' -c "
  SELECT relname, n_live_tup
    FROM pg_stat_user_tables
   WHERE schemaname='public'
   ORDER BY relname;" > supabase-counts.csv
```

On **Aurora**:
```bash
psql "$AURORA_DB_URL" -t -A -F',' -c "
  SELECT relname, n_live_tup
    FROM pg_stat_user_tables
   WHERE schemaname='public'
   ORDER BY relname;" > aurora-counts.csv

diff <(sort supabase-counts.csv) <(sort aurora-counts.csv) > count-diff.txt
```

`n_live_tup` is an estimate — good for spotting large divergence fast. For any
table that differs, follow up with an exact `COUNT(*)` on both sides.

**Also report tables present on one side and absent on the other.** We already
know 103 tables declared by migrations don't exist in Supabase production
(VTID-03486); Aurora may differ again.

## Step 3 — Content checksum on the tables that matter

Row counts match while contents differ if updates were dropped. For the
highest-value tables, compare a content hash:

```sql
-- run identically on BOTH, compare the hashes
SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.app_users t;
```

Priority tables: `app_users`, `user_tenants`, `memberships`, `vtid_ledger`,
`memory_facts`, `memory_items`, `chat_messages`, `wallet_ledger_entries`,
`user_subscriptions`.

Wallet and membership divergence is the most dangerous class — it is money and
access.

## Step 4 — Is it still happening?

Insert a marker on Supabase, wait, confirm arrival on Aurora, and measure lag:

```sql
-- Supabase
INSERT INTO public.oasis_events (topic, service, status, message)
VALUES ('dms.reconciliation.probe','phase0','info','VTID-03494 probe');
```
```sql
-- Aurora, ~60s later
SELECT created_at, message FROM public.oasis_events
 WHERE topic='dms.reconciliation.probe' ORDER BY created_at DESC LIMIT 1;
```

Repeat a few times, including during a busy period. Record observed lag.

---

## Exit criteria

Phase 0 is closed only when **all** are true:

- [ ] The ~154k dropped applies are root-caused — which tables, which rows, and
      *why* DMS dropped them silently.
- [ ] Full 510-table count reconciliation, with every divergence explained.
- [ ] Content checksums match on the priority tables in Step 3.
- [ ] A **re-runnable** reconciliation job exists (not a one-time manual pass).
- [ ] Zero unexplained divergence sustained over **7 days**.

The 7-day window is deliberate and it is the reason this cannot complete today.
A point-in-time match does not prove a replication path is sound — the original
failure was silent and continuous.

---

## What to send back

1. Raw `describe-table-statistics` output (Step 1).
2. `count-diff.txt` (Step 2).
3. Checksum comparison for the Step 3 tables.
4. Observed replication lag (Step 4).
5. Your read: is the ~154k historical backfill damage, or is it ongoing?

That last one determines whether Phase 0 is "re-seed Aurora and re-verify" or
"the replication design is wrong and needs replacing" — very different amounts
of work.

## If you find it is unrecoverable

That is a legitimate outcome and worth saying early. If DMS cannot be trusted for
this dataset, the alternative is a **dump/restore cutover with a write freeze**
(`pg_dump` from Supabase → `pg_restore` into Aurora) rather than continuous
replication. That trades a maintenance window for certainty, and for a
199-user platform the window is likely to be small. Do not spend days trying to
rescue DMS if a clean re-seed is provably sound.
