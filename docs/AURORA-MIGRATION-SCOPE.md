# Supabase → Aurora: scope of the actual migration

**VTID-03566 · scoping only, authorizes nothing · measured 2026-08-10 from live AWS**

Owner decision (2026-08-10): *Aurora is the live DB for staging and production,
no more Supabase.* This document scopes what standing between that decision and
reality actually consists of.

`SUPABASE-TO-AURORA-MIGRATION-PLAN.md` remains the plan of record. This adds
what that plan could not have: **live AWS measurements**, taken with read-only
credentials. Its Phase 0 is marked open with the note *"Owner needs: live
AWS/DMS access. No session so far"* — that gap is now closed, and what it
reveals changes the sequencing.

---

## 1. The headline: nothing points at Aurora

| Task definition | Role | DB secrets attached |
|---|---|---|
| `vitana-gateway-awsdr` rev 51 | **production** (`vitanaland.com`) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY` |
| `vitana-gateway` rev 173 | staging | identical |

Neither carries `AURORA_DATABASE_URL` or `DATABASE_URL`. **Every runtime read
and write in production goes to Supabase over PostgREST**, today.

Aurora `vitana-aurora-prod` is `available` and healthy — writer and reader
both `PubliclyAccessible=false` in a private VPC, `IAMDatabaseAuthenticationEnabled=false`.
It simply has no callers.

So "Aurora is the live DB" is the target state, not the current one. Any change
made on the assumption that it is already live will write to a database no user
reads.

---

## 2. Why replication has been dead for two weeks — probable root cause

This is the finding that matters most, because it is specific and testable.

### What the tasks actually did

| Task | Direction | Status | Real work done |
|---|---|---|---|
| `vitana-supabase-to-aurora` | `vitana-source-supabase` → `vitana-target-aurora-prod` | stopped, `NORMAL`, 2026-07-21 | **495 tables, 0 errored**; 58,554 inserts + 129,426 updates + 8,660 deletes = **196,640 CDC operations** |
| `vitana-reload-39-tables` | full-load only | stopped, `FULL_LOAD_ONLY_FINISHED`, 2026-07-27 | 39 tables loaded, **1 errored**: `public.autopilot_recommendations` |
| `vitana-supabase-to-aurora-v3` | `vitana-src-supabase-v3` → `vitana-tgt-aurora-v2` | **restarted today 11:20 UTC, failing** | 0 inserts/updates/deletes — it has never replicated anything |

**v3 is not a half-finished migration.** In its last completed attempt, 471 of
500 tables were still in `Before load` — the full load never began for them.
Aurora's contents are essentially whatever v1 left on **2026-07-21**, plus the
39-table reload on 07-27. That is much better news than "154k rows dropped into
an unknown state": the copy is stale, not scrambled.

### The failure signature

DMS event history, 14 days:

```
07-27 17:30  Replication task has failed. Reason: Network error has occurred  RECOVERABLE_ERROR
07-27 17:41  started …
08-07 09:48  failed. Network error has occurred  RECOVERABLE_ERROR
08-07 09:53  failed. Network error has occurred  RECOVERABLE_ERROR
08-07 09:59  failed. Network error has occurred  RECOVERABLE_ERROR
08-07 10:10  failed. Network error has occurred  RECOVERABLE_ERROR
08-07 10:32  failed. Task was stopped after 7 recovery attempts  FATAL_ERROR
08-10 11:12  failed. Table error occurred …          ← today, someone is retrying
08-10 11:16  failed. Table error occurred …
```

Nine failures over two weeks, and until today **every one was a network error**,
not a data error.

### The hypothesis

- The DMS instance `vitana-dms-prod` is `PubliclyAccessible=True` with public IP
  **`63.186.134.8`**, and both source endpoints point at
  `db.inmkhvwdcuyhnxkgfvsb.supabase.co` — so DMS reaches Supabase **over the
  public internet**.
- **Supabase has a network allow-list.** Verified directly: TCP 5432 to that
  host from an arbitrary address times out. This repo already knows this — it
  is exactly why every `psql`-from-GitHub-Actions workflow is structurally dead
  (VTID-03485 / VTID-03486, changelog 2026-08-04).
- v1 replicated 196k operations successfully in July, so the path worked then.
  A DMS replication instance's **public IP can change** across maintenance or
  restart.

**Therefore: the most probable cause of two weeks of `Network error` is that
`63.186.134.8` is not on Supabase's allow-list** — either it never was, or the
instance's IP changed after v1's successful run.

**This is a hypothesis, not a confirmed diagnosis.** Confirming it needs one
look at the Supabase project's Network Restrictions page, which this session
cannot reach. It is cheap to test and would explain everything, so test it
first.

> **Someone is actively retrying v3 right now** (modified 11:07, started 11:08,
> failed 11:12, started 11:14, reload requested 11:15, failed 11:16, modified
> 11:20 — all 2026-08-10 UTC). Today's failures changed from `Network error` to
> `Table error`, which may mean the network issue was just fixed and the next
> layer is now surfacing. Coordinate before touching these tasks.

---

## 3. Scope: what the migration actually consists of

Five workstreams. Only the first is a prerequisite for all the others.

### W1 — Restore a trustworthy copy (blocks everything)

1. Confirm or refute the allow-list hypothesis above.
2. If confirmed: add `63.186.134.8/32` to Supabase Network Restrictions, or move
   DMS to a private path. **Pin the IP** — an Elastic IP on the replication
   instance, or the allow-list breaks again on the next maintenance window.
3. Resolve `public.autopilot_recommendations` (errored in the 07-27 reload) and
   whatever table errors v3 is hitting today.
4. Run a full row-count + checksum reconciliation, Supabase vs Aurora, per
   table — the Phase 0 exit criterion. `scripts/db-i18n/seed-aurora.sh --verify`
   already implements this shape for the two i18n tables; it needs generalising
   to all 495.

**Exit:** every table reconciles, and CDC has been running clean for a
measured period.

### W2 — Give the gateway a way to reach Aurora at all

The gateway speaks **HTTP to PostgREST**, not Postgres. `SUPABASE-TO-AURORA-MIGRATION-PLAN.md`
§0 records that it had no Postgres driver at all until VTID-03517 added one for
the i18n surfaces.

- ~2,480 call sites use the Supabase client.
- Repointing is **not** a connection-string change. It is a client-shape change:
  PostgREST filter builders → SQL.
- The plan's own B1 sequencing says build the seam first or the call sites get
  rewritten twice. `db-i18n-repository.ts` is the worked example of that seam
  for one surface.

**This is the largest workstream by far and should be estimated separately.**

### W3 — RLS and auth

Supabase enforces tenant isolation through RLS tied to Supabase Auth JWTs, and
CLAUDE.md's "Always enforce tenant isolation (RLS)" / "Never bypass RLS" are
hard rules. Aurora has no Supabase Auth. Either RLS policies are ported with an
equivalent claims mechanism, or isolation moves into the application layer —
a security-significant decision that needs an explicit written answer, not a
default.

Also live on Supabase and not covered by DMS table replication: Auth (GoTrue —
note the separate `vitana/gotrue/prod/db-url` secret), Storage, Realtime, and
Edge Functions. **Which of these move, and which stay, is undecided.**

### W4 — Network placement

Aurora is private with no IAM DB auth. Anything that must reach it has to be
inside the VPC. Already known to be outside:

- GitHub-hosted Actions runners → `I18N-DB-SEED.yml` and every future DB job
  (VTID-03564 added a preflight so this fails in 5s with a clear message rather
  than an unexplained hang)
- Any local or agent tooling

Options: VPC-connected self-hosted runners, a bastion, or moving DB work behind
gateway admin endpoints. Pick one deliberately — the ad-hoc answer is a bastion
that becomes permanent shadow infrastructure.

### W5 — Cutover and rollback

Dual-writing is explicitly rejected by the plan as "Option C". So the cutover is
a stop-the-world: quiesce writes, final delta, verify, repoint task definitions,
resume. That needs a written rollback with a real trigger condition, in the
shape of `docs/AWS-CUTOVER-RUNBOOK.md` §3's DNS record.

---

## 4. What is already done

Not everything is ahead. VTID-03517 delivered the seam pattern and a working
Postgres client:

- `services/gateway/src/services/db-i18n/aurora-client.ts` — TLS against the RDS
  CA bundle, failing closed; `sslmode=disable` honoured for loopback only
- `AuroraDbI18nRepository` — real SQL, 17 integration tests against a live
  PostgreSQL 16, not mocks
- Connectivity (`AURORA_DATABASE_URL`) and write permission
  (`AURORA_I18N_WRITES`) as **separate** flags
- `--verify` — the row-count + `source_sha` checksum reconciliation, the
  concrete slice of Phase 0's exit criteria
- `scripts/db-i18n/seed-aurora.sh` — in-VPC runner (VTID-03517)
- `DB_I18N_TARGET` now defaults to `aurora` (VTID-03564) for this one
  seeder-only surface

The pattern generalises. The volume does not shrink.

---

## 5. Recommended order

1. **W1 step 1** — check the Supabase allow-list against `63.186.134.8`. One
   look, and it plausibly explains two weeks of failure.
2. Finish W1 to a clean reconciliation. Nothing else is safe until Aurora is
   trustworthy.
3. Decide W3 (RLS/auth) and W4 (network placement) **on paper** before writing
   code — both change what W2 has to build.
4. Estimate W2 properly against the 2,480 call sites.
5. Write W5 as a runbook with a rollback trigger, then execute under its own VTID.

**Do not seed DB-content i18n into Aurora before W1 closes.** Correct
translations written into a two-week-stale database that no service reads is
work that has to be redone, and it would read as progress.

---

## 6. Open questions for the owner

1. Who restarted `vitana-supabase-to-aurora-v3` today at 11:20 UTC, and is that
   effort coordinated with this?
2. Do Supabase Auth, Storage, Realtime and Edge Functions move to AWS, or stay?
   This determines whether "no more Supabase" means the database or the whole
   platform.
3. RLS: port the policies, or move tenant isolation into the application?
4. Is there an existing bastion or VPC-connected runner, or does W4 need one built?
