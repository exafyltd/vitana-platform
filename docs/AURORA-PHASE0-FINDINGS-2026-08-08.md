# Phase 0 — measured. Aurora is a stale, incomplete, idle replica.

**2026-08-08** · First session with live AWS access (`claude-code-diagnostics`,
read-only). This closes the Phase 0 question open since 2026-07-27 that no
previous session could answer.

**Everything below is measured from the AWS APIs, not inferred from the repo.**

---

## Headline

Aurora (`vitana-aurora-prod`) is **provisioned, reachable, and doing nothing.**
Its data is a **27 July full-load snapshot, missing 7 tables entirely**, with
**no replication since**. Nothing reads from it and nothing writes to it.

---

## 1. Replication is dead — all three DMS tasks

```
vitana-supabase-to-aurora      stopped   NORMAL                   last start 2026-07-21
vitana-supabase-to-aurora-v3   FAILED    FATAL_ERROR              last start 2026-07-27
vitana-reload-39-tables        stopped   FULL_LOAD_ONLY_FINISHED  last start 2026-07-27
```

`v3` — the live one — reports:

> Task '6HXJWOLRF5FA3DND3TLMGXHY4I' was stopped after **7 recovery attempts**
> Stop Reason FATAL_ERROR Error Level FATAL

It is still crash-looping. It was restarted **2026-08-07 10:30:45** and stopped
**10:31:15** — dead in **30 seconds**. Its log stream records the task server
banner and then nothing; it dies before writing a diagnosis.

Note the task name: `vitana-supabase-to-aurora`. Supabase is the **source**,
Aurora the **target**. Direction matters — Aurora was never upstream.

## 2. Seven tables never loaded, and they are the memory core

`TablesLoaded: 494`, **`TablesErrored: 7`**. The seven, each with
`FullLoadRows: 0`:

```
products   knowledge_docs   ai_memory   mem_episodes
memory_items   memory_facts   user_intents
```

`memory_items` and `memory_facts` are what CLAUDE.md §14 calls canonical
infinite memory. On Aurora they are **empty**.

### 2b. Root cause of the 7 — tested, and it is not what §5 first guessed (VTID-03550)

The first draft of this document called a `pgvector` type-mapping failure "the
obvious hypothesis." **Tested against production, that hypothesis is wrong as
stated** — and the correction is what makes it actionable.

Having a `vector` column does **not** predict failure. `mem_facts` carries
`vector(1536)` across 12,136 rows and loaded fine. Dimension does not predict
it either — `calendar_events` is `vector(1536)` and loaded fine.

What predicts it exactly is **holding at least one non-null `vector` *or*
`tsvector` value.** Across all 12 tables in the database that carry either
type, the separation is clean with no exceptions:

| table | populated vector/tsvector values | DMS |
|---|---|---|
| `mem_episodes` | 2748 `vector` | **errored** |
| `memory_items` | 1062 `vector` | **errored** |
| `memory_facts` | 662 `vector` | **errored** |
| `products` | 325 `tsvector` | **errored** |
| `knowledge_docs` | 297 `tsvector` | **errored** |
| `user_intents` | 95 `vector` | **errored** |
| `ai_memory` | 82 `vector` | **errored** |
| `mem_facts` | 0 (column exists, all NULL) | loaded |
| `calendar_events` | 0 (column exists, all NULL) | loaded |
| `feedback_tickets` | 0 (column exists, all NULL) | loaded |
| `memory_embeddings` | 0 (empty table) | loaded |
| `community_listings` | 0 (empty table) | loaded |

7 errored / 7 populated. 5 loaded / 5 unpopulated. **12 for 12.**

Two things follow that the original hypothesis would have missed:

1. **It is not only `pgvector`.** `knowledge_docs` has no vector column at all
   — it fails on `tsvector`. A fix scoped to embeddings would have left it
   broken and looked like a partial success.
2. **It fails on the value, not the schema.** DMS created all 501 tables
   happily; it dies when a row carrying one of these types has to be
   serialised. So "the tables exist on Aurora" was never evidence of anything,
   and a schema-level comparison would have reported these as fine.

This is a DMS capability limit for extension and derived types, not a
misconfiguration — there is no setting that makes it transfer a `vector`. That
is why the recommendation below is dump/restore rather than repairing CDC.

Reproduce:

```sql
select 'memory_items' t, count(*) rows, count(embedding) non_null from memory_items
union all select 'mem_facts', count(*), count(embedding) from mem_facts;
```

## 3. DMS validation was never switched on

Every table reports `ValidationState: "Not enabled"`.

This retires the long-standing "~154k silently-dropped row applies" item — not
by resolving it, but by explaining it. **With validation disabled, DMS was never
in a position to detect divergence at all.** Any confidence in Aurora's fidelity
to date rests on a check that was switched off.

## 4. Aurora is idle — measured, not assumed

CloudWatch, `vitana-aurora-prod`, 6-hour window:

| metric | value |
|---|---|
| `DatabaseConnections` | **2.0 flat** (avg = max, every hour) |
| `DMLThroughput` | **no data** |
| `SelectThroughput` | **no data** |
| `WriteIOPS` | ~3.8 avg (background checkpoint/WAL) |

Two connections that never vary is a pool held open by one long-running
service. Zero DML and zero SELECT throughput means **nothing is reading or
writing application data.** A database serving an app does not look like this.

## 5. What each service actually uses

| service | client | target |
|---|---|---|
| `oasis-projector` | `@prisma/client` + `DATABASE_URL` via `vitana-rds-proxy-prod` | **Aurora** |
| `gateway` | `@supabase/supabase-js` | **Supabase** |
| `worker-runner`, `oasis-operator`, `vitana-orchestrator` | neither | call the gateway |

The gateway's task definition (`vitana-gateway-awsdr:49`, the revision actually
running) **does** carry Aurora config:

```
DB_HOST         vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com
DB_READER_HOST  vitana-aurora-prod.cluster-ro-cfk228aiedf3...
secrets: DB_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY
```

But the gateway **declares no Postgres driver** in `package.json` and **never
references `DB_HOST`** in its source. Those variables are provisioned and
inert. The Supabase secrets beside them are the ones actually used.

Independent confirmation from 2026-08-05: applying the `orb_session_state`
migration **to Supabase** flipped live production `audio_ready.acked` from
`ok:false` to `ok:true` with no redeploy. Production behaviour changed because
Supabase changed.

---

## What this means

**Supabase is the system of record. Aurora is a stale partial copy.** The
groundwork is real — cluster, proxy, one service wired up, task-def config
staged — but the data layer has not moved.

**The risk worth naming:** if a cutover proceeds on the belief that Aurora is
current, it would promote a 27-July snapshot with empty `memory_items`,
`memory_facts` and `ai_memory` to primary, and lose everything since. Because
validation is off, that would not announce itself.

## Recommended next steps

Revised after §2b (VTID-03550). The earlier list led with "root-cause the v3
FATAL"; §2b makes that the wrong first move, because the failure is a DMS
capability limit rather than a fault to repair.

1. **Do not treat Aurora as a failover target** until §1–§3 are resolved.
2. **Stop trying to repair DMS. Switch to `pg_dump`/`pg_restore`.** §2b shows
   DMS cannot carry `vector` or `tsvector` values at all, so no amount of
   endpoint or task tuning fixes the seven tables — and those seven include the
   memory core. Native dump/restore handles both types, and at this data volume
   (~110 MB across the affected tables, 199 users) a short write freeze is
   cheap. `tsvector` columns are *derived* and should be recomputed on the
   target rather than transferred at all.
3. **Rehearse into a scratch database first**, not `vitana-aurora-prod`, and
   diff row counts plus a sample of embedding values per table before trusting
   it. The failure mode this whole document is about is a copy that was
   believed current and never checked.
4. **If any form of ongoing replication is kept**, enable DMS validation and
   exclude the seven tables from the DMS task explicitly — an excluded table is
   visibly absent, whereas today they are silently empty.
5. **Root-cause the `v3` FATAL only if replication is kept.** It dies in 30s
   with no log line; start from the DMS console event list and endpoint
   connection tests, since the task log is empty. It is a lower priority than
   it looked before §2b.

## Correction to earlier statements in this workstream

An earlier session claim that there was "no Aurora anywhere in the gateway" was
overreach: it generalised from the gateway's source to the platform, and missed
`oasis-projector`, which genuinely runs on Aurora. Aurora is in real use by one
service. The broader conclusion — Supabase is the system of record — survives,
and is now measured rather than inferred.
