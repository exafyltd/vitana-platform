# Supabase → Aurora Migration Plan

**VTID-03494** · Status: **DRAFT — planning only, no code changed** · 2026-08-04

Written at explicit user direction ("Aurora is the target — plan it"). This
document does **not** authorize execution. Every phase below needs its own
execution VTID, and Phase 0 is a hard gate on all of them.

---

## 0. The headline finding

**This is not a database migration. Aurora is *just Postgres*; Supabase is an
application platform that happens to contain a Postgres.** The Postgres part is
the small half of the work.

Measured against production (`inmkhvwdcuyhnxkgfvsb`) on 2026-08-04:

| Supabase component | What it does for us | Aurora equivalent | Surface to replace |
|---|---|---|---|
| **PostgREST** | The entire `.from()` / `.rpc()` data API | **none** | 2,280 `.from()` + 270 `.rpc()` call sites (166 distinct RPCs) in the gateway |
| **GoTrue (Auth)** | Signup, login, JWT issuance, sessions | **none** | 199 live users; 194 auth call sites in the frontend; 15 in the gateway |
| **RLS via `auth.uid()`** | Per-user/tenant isolation | Postgres has RLS, but `auth.uid()`/`auth.jwt()` are GoTrue constructs | **925 policies** on **506 tables**; **557** reference `auth.uid()`, **65** reference `auth.jwt()` |
| **Realtime** | Live subscriptions | **none** | 60 `.channel()` in frontend, 19 in gateway |
| **Storage** | File/object storage + policies | S3, but a different API | 19 frontend + 4 gateway call sites; 8 objects in `storage` schema |
| **Edge Functions** | Deno serverless | Lambda/ECS, different runtime | **74 functions** in `vitana-v1/supabase/functions/` |
| **Vault** | Secret storage in-DB | Secrets Manager | `supabase_vault` extension |
| **pg_cron / pg_net** | In-DB scheduling + HTTP | pg_cron yes on Aurora; **pg_net is not available on RDS** | needs audit |

Files importing `@supabase/supabase-js`: **496** in `services/`, **207** in
`vitana-v1/src/`.

**Consequence:** "point the app at Aurora" is not a config change. There is no
connection string to swap, because the gateway never opens a Postgres
connection — it has no Postgres driver dependency at all. It speaks HTTP to
PostgREST. Aurora does not speak that protocol.

### Extensions in use

`fuzzystrmatch, pg_cron, pg_net, pg_stat_statements, pg_trgm, pgcrypto, pgmq,
plpgsql, supabase_vault, unaccent, uuid-ossp, vector 0.8.0`

Two need explicit decisions: **`pg_net`** (not offered on RDS/Aurora — anything
calling it needs rewriting) and **`supabase_vault`** (Supabase-specific).
**`vector 0.8.0`** is available on Aurora but the version must be matched or the
memory embeddings need reindexing.

---

## Phase 0 — GATE: Aurora is not currently a trustworthy copy

**Nothing below Phase 0 may start until this is closed.**

VTID-03419 (2026-07-27) excluded every Aurora-dependent service from the GCP→AWS
cutover because **DMS showed ~154,000 silently-dropped row applies**. The
2026-07-31 investigation reopened that checklist item and it remains
**unresolved** — that session had no live DMS access
(`aws sts get-caller-identity` returned `InvalidClientTokenId`), and neither
does this one (no AWS CLI present).

Until this is understood, Aurora holds an unknown-quality partial copy of
production. Migrating onto it would promote silent data loss to primary.

**Exit criteria:**
1. Root-cause the ~154k dropped applies — which tables, which rows, why DMS
   dropped them silently rather than erroring.
2. Full row-count + checksum reconciliation, Supabase vs Aurora, per table
   (510 tables).
3. A re-runnable reconciliation job, not a one-time manual check.
4. Zero unexplained divergence sustained across a 7-day window.

**Owner needs:** live AWS/DMS access. This is the first real blocker and it is
not a code task.

---

## Phase 1 — Decide the target architecture

Three genuinely different end-states. This is the decision that shapes
everything else, and it has not been made.

### Option A — Self-hosted Supabase on AWS
Run the Supabase stack (PostgREST, GoTrue, Realtime, Storage) against Aurora.

- **Keeps** all 2,550 data call sites, all 925 RLS policies, `auth.uid()`, and
  the 74 edge functions *conceptually* intact.
- **Cost:** operating 5+ stateful services we currently get managed.
- **Risk:** lowest code churn, highest ops burden.
- *Note:* Supabase's own docs do not support pointing a self-hosted stack at an
  external Aurora writer as a first-class configuration — this needs a
  feasibility spike before it can be costed.

### Option B — Replace the platform (true "Aurora-native")
Gateway opens real Postgres connections; auth moves to Cognito or a
self-issued-JWT service; realtime to WebSockets we own; storage to S3; edge
functions to Lambda.

- **Cost:** rewrite 2,550 data call sites, re-implement 557 `auth.uid()`
  policies against a new identity source, migrate 199 users' credentials,
  rebuild 74 edge functions, replace 79 realtime subscriptions.
- **Risk:** highest. This is a multi-quarter programme, not a migration.
- **Benefit:** no Supabase dependency, full AWS consolidation.

### Option C — Hybrid, and the one to argue against
Gateway writes some tables direct-to-Aurora while Supabase remains for
auth/realtime.

- Creates **two writers over DMS-replicated tables** — precisely the dual-writer
  hazard that got `oasis-projector` excluded from VTID-03419.
- Documented here so it is rejected deliberately rather than drifted into.

**Recommendation:** Option A if the goal is AWS consolidation and cost; Option B
only if removing the Supabase dependency is itself the goal. Both are large; A
is roughly an order of magnitude less code churn.

---

## Phase 2 — Freeze the drift before migrating anything

Migrating a schema we do not fully control would carry existing problems across.
Two are already known and open:

1. **103 tables declared by migrations do not exist in production**
   (VTID-03486), including `products_catalog`, `services_catalog` and
   `relationship_signals`, which CLAUDE.md documents as canonical.
2. **Recorded migration versions do not match migration files** — 377 file
   versions vs 330 applied rows, overlapping by 2. There is no reliable record
   of what has actually run.

Related and plausibly causal: `RUN-MIGRATION.yml` could not connect to the
database from CI for an unknown period (VTID-03492), so migrations were applied
by hand. **Worth testing directly once `SUPABASE_ACCESS_TOKEN` is set**: pick one
baselined-missing table, run the now-working workflow, see whether it applies
cleanly. If it does, that is strong evidence the backlog is simply un-run
migrations rather than deliberate removals.

**Exit criteria:** every one of the 103 is either applied or its `CREATE`
deliberately removed; the baseline is empty; migration state is trustworthy.

---

## Phase 3 — Schema and data transfer

Only meaningful after Phases 0–2.

1. Schema DDL: 510 tables, 582 functions, 203 triggers, 925 policies.
2. Extension parity — resolve `pg_net` and `supabase_vault` (Phase 1 decision).
3. `vector` version match, or plan embedding reindex.
4. Data: DMS for bulk + a verified cutover delta.
5. Reconciliation gates from Phase 0 re-run against the final copy.

## Phase 4 — Application cutover

Shape depends entirely on the Phase 1 choice. Common requirements:

- A reversible switch — env-var/flag, not a redeploy, mirroring how
  `PUBLISH_TARGET_CLOUD` was done for the AWS publish path.
- Supabase stays running and re-activatable as the rollback target, exactly as
  GCP was kept for VTID-03419.
- Per-surface rollout (read paths before write paths), never big-bang.

## Phase 5 — Decommission Supabase

Explicitly **out of scope** until Phase 4 has been stable for an agreed window.

---

## What I did not do, and why

- **No code changed.** The instruction was to plan.
- **No execution VTID allocated.** Following the precedent set for the GCP
  full-cutover spec: allocation belongs to whoever has the sign-off
  conversation, not to the planning step.
- **CLAUDE.md ALWAYS rule 21 still says "Always use Supabase as the persistent
  data store."** That rule and this plan are in direct conflict. The rule should
  be amended as part of the Phase 1 decision — not silently ignored, and not
  edited by me ahead of that decision.

## Open questions for the user

1. **Which option in Phase 1** — A (self-host Supabase on Aurora), or B (full
   platform replacement)? Everything downstream depends on it.
2. **What is the actual driver** — cost, AWS consolidation, removing a vendor
   dependency, or something else? A and B serve different goals.
3. **Who has live AWS/DMS access** to close the Phase 0 gate? No session so far
   has had it.
4. **Is there a deadline** this is working back from?
