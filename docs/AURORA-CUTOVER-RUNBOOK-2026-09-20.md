# Supabase → Aurora Cutover Runbook — 2026-09-21 00:00 CET (midnight)

**UPDATED 2026-09-20: the freeze window was moved from 22:00 CET to
midnight CET (00:00 CET, 2026-09-21 = 22:00 UTC, 2026-09-20) per explicit
platform-owner instruction. Every other rule/step below is unchanged.**

**This is the execution checklist for tonight's deadline. It consolidates
everything already decided and verified in `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`
(2026-09-18/19/20 addenda) into one ordered, copy-paste-ready sequence. Read
the status doc for the *why*; read this for the *what, in what order*.**

Target architecture: **Option A** — Supabase Auth (GoTrue) stays on Supabase
permanently, free tier. Everything else (all Postgres data) moves to Aurora.
This is a one-time **dump/restore cutover during a bounded write freeze**,
not continuous replication (CDC is blocked — Supavisor can't proxy logical
replication — and there isn't time left to fix that before tonight).

**Standing rules that apply throughout tonight, unconditionally:**
- Never delete, stop, or economize on any AWS resource for cost reasons —
  AWS runs on a 12-month credit grant, cost is not a concern there. Supabase's
  paid add-on is the only thing being cut, and only *after* cutover succeeds.
- Never take a destructive AWS action (delete/terminate/drop) without a live
  human's explicit go-ahead for that specific action, even if a similar
  action was approved earlier the same night.
- If a step below needs a decision this document doesn't already make,
  stop and ask rather than guessing.

---

## Pre-freeze (no downtime, can run any time before the window)

### Step 1 — Fix the two pgvector-broken tables

**UPDATED 2026-09-20, executed this session — root cause is deeper than
originally documented.** The `vector(N) USING NULL` retype below WAS run
successfully (both columns now correctly typed `vector`), but a DMS reload
afterward still failed to populate either table — **DMS's bulk-load writer
cannot write into a native `vector`-typed column at all**, confirmed via a
controlled manual-SQL test (a real vector literal inserts/updates fine
directly in Postgres; only DMS's own COPY-based writer fails). This
supersedes the original "corrupted varchar was too short" theory. Full
detail, live CloudWatch evidence, and the isolation test:
`docs/AURORA-MIGRATION-STATUS-2026-09-10.md`, "2026-09-20 — pgvector fix
executed" addendum.

**The retype (already done, safe to re-run/confirm — both tables are still
empty):**

```sql
ALTER TABLE public.vtid_ledger      ALTER COLUMN embedding TYPE vector(1536) USING NULL;
ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE vector(1024) USING NULL;
```

Run via RDS Data API against the `vitana` database on `vitana-aurora-prod`,
using the RDS-managed master secret (NOT `vitana/aurora/prod/claude-readonly`
— that credential lacks table-owner privileges for `ALTER TABLE`):

```bash
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
SECRET_ARN="arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2"

aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE vector(1536) USING NULL;"

aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE vector(1024) USING NULL;"
```

**The actual remaining fix — stage as `text`, reload, then cast back:**

```bash
aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE text USING embedding::text;"

aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE text USING embedding::text;"
```

Then reload just these two tables (`TableName=`, not `Name=` — the AWS CLI
parameter is `TableName`; this file previously had this wrong). The task
must be in `running` state first — `reload-tables` on a `stopped` task
fails with `InvalidResourceStateFault`, and starting via
`resume-processing` can self-terminate before honoring the reload if there
is no outstanding CDC backlog. If a scoped reload doesn't take, fall back
to `start-replication-task-type reload-target`, which forces a full reload
of every table in the task's mapping (~16 min for this task's ~594
tables) and is the more reliable of the two:

```bash
aws dms reload-tables --region eu-central-1 \
  --replication-task-arn arn:aws:dms:eu-central-1:472838866351:task:VWJEA6Z5DFCJLNGD5O4B4YBQYE \
  --tables-to-reload TableName=vtid_ledger,SchemaName=public TableName=dev_agent_memory,SchemaName=public \
  --reload-option data-reload
```

Once the text columns are populated (non-zero row counts, real embedding
strings), cast back to `vector` for real:

```bash
aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector;"

aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector;"
```

Verify afterward (expect non-zero rows, and the `vector` type holding):

```bash
aws rds-data execute-statement --region eu-central-1 \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "SELECT (SELECT count(*) FROM vtid_ledger) AS vtid_ledger, (SELECT count(*) FROM dev_agent_memory) AS dev_agent_memory;"
```

**If there's no time left to fix this before the window:** these are 2 of
594 tables. Cutover can proceed without them and they can be backfilled
post-cutover — flag this explicitly as a known gap rather than blocking
the whole cutover on it.

**CLOSED OUT THIS SESSION, TREAT AS THE BACKFILLABLE-GAP CASE ABOVE, NOT A
BLOCKER.** Ran the full sequence above with explicit approval: the `text`
widen succeeded, DMS reload succeeded (594/594 tables, 0 errors, row counts
match Supabase exactly — `vtid_ledger` 1987/1987, `dev_agent_memory`
97/97), but the final cast back to `vector` **failed** — DMS silently
truncates the embedding text to a fixed 3064 characters regardless of the
live column definition (a third, deeper root cause: stale DMS-side target
metadata cached from the original `varchar(1532)` schema-conversion
artifact, which a direct Postgres `ALTER` cannot invalidate). Full detail
and the likely real fix: `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`,
"2026-09-20, later — approved and executed, and hit a THIRD, deeper root
cause" addendum. **Both columns are now `text`, correctly populated (but
truncated/unusable as vectors).** Do not re-attempt the `vector` cast
during tonight's freeze window without first addressing the truncation —
it will fail the same way. This does not block cutover; proceed per the
"if there's no time left" note above.

### Step 2 — `products`/`knowledge_docs` — RESOLVED 2026-09-20, no action needed

**Closed out this session.** Confirmed live: both tables loaded
successfully in the most recent full reload (the same `reload-target` run
executed for Step 1 above reloaded these too, since it reloads the task's
entire table mapping). Row counts, Aurora vs. Supabase, checked directly:

| Table | Aurora | Supabase | Delta |
|---|---|---|---|
| `products` | 750 | 754 | 4 (ordinary live-write drift under Option A — no CDC, same category as `oasis_events`/`memberships`/`reminders`) |
| `knowledge_docs` | 297 | 297 | 0 |

The "known-broken" classification from earlier full-load attempts (under
the old `DROP_AND_CREATE` prep mode) no longer applies — whatever caused it
before does not reproduce under `TRUNCATE_BEFORE_LOAD`. No schema fix, no
special handling, no exclusion needed. The freeze-window final reload
(Step 6 below) will pick up any further drift the same way it does for
every other table — nothing distinct about these two any more.

### Step 3 — Provision the PostgREST-Aurora proxy (owner/admin action)

This session's AWS identity is denied `ecr:CreateRepository`,
`ecr:GetAuthorizationToken`, and `ecs:CreateService` — confirmed live,
still blocking as of this writing. Someone with AWS admin rights needs to:

```bash
scripts/aws/setup-postgrest-aurora-proxy-staging.sh provision --apply
```

Then let `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`
build and roll the image (push to `main` under `services/postgrest-aurora-proxy/`,
or dispatch it manually).

**Smoke-test before trusting it for anything real:**
1. A real login through the proxy's `/auth/v1/*` passthrough (it forwards
   to real Supabase GoTrue unconditionally, header-for-header — confirm
   this actually works end-to-end, not just in theory).
2. A `.from()` read through `/rest/v1/*` (the local PostgREST-on-Aurora
   sidecar).
3. An RLS-sensitive read (two different users/tenants) confirming tenant
   isolation actually holds through the proxy — this is the one check
   that, if skipped, could silently violate ALWAYS rule 22 / NEVER rule 8
   (tenant isolation / RLS bypass).

**One `SUPABASE_URL` repoint covers the gateway's entire surface** (~601
files — confirmed by reading every Auth call site, not just grepping the
env var name; see status doc's 2026-09-19 "later still" addendum). No
`SUPABASE_AUTH_URL` split needed.

**The frontend (`exafyltd/vitana-v1`) needs a SEPARATE repoint** — it talks
to Supabase directly (649 call sites, 282 files) through a hardcoded-URL
generated `src/integrations/supabase/client.ts`, not through the gateway.
PR #1117 in that repo makes this an env-var change (`VITE_SUPABASE_URL`)
instead of a hand-edit, but it still needs a rebuild + redeploy, not a
runtime flag flip — and the proxy needs to be **publicly reachable** for
the browser to reach it (not just the VPC-internal Cloud Map DNS the
gateway's leg uses). This is not yet built — decide before the window
whether the frontend repoint happens in the same freeze window or as a
fast-follow, since a gap between the two repoints is a real split-brain
risk (gateway on Aurora, browser still writing Supabase).

---

## The freeze window

**Mechanism: DB-level REVOKE, not app-level maintenance mode.** Blocks
every write path (gateway, frontend-direct, edge functions, cron) at the
database-role level in one shot, rather than trusting every write path in
two repos to already route through one choke point.

**Tolerance: 15-60 minutes.** The proven `vitana-fullload-only`/`-v2` runs
took 15.5-16 min for the whole dataset.

### Step 4 — Freeze writes

```bash
psql "$AURORA_ADMIN_URL"   # or via RDS Data API, statement-by-statement
\i scripts/aws/aurora-cutover-freeze-writes.sql
```

This runs a blanket `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
public FROM anon, authenticated, service_role`. Safe as a blanket statement
— revoking can only narrow privileges. Confirmed DMS's own connection role
(`postgres.inmkhvwdcuyhnxkgfvsb`) is NOT one of the three revoked roles, so
the final DMS run is unaffected by the freeze. Auth-schema writes and
Storage are deliberately left unfrozen (login must keep working; neither
is part of this Postgres dump/restore).

**Regenerate `scripts/aws/aurora-cutover-restore-grants.sql` immediately
before this step if any schema/grant changes have landed since 2026-09-19**
— it's a live snapshot of Supabase's actual grants, not a static file.

### Step 5 — Final full-load run

Clone `vitana-fullload-rehearsal-v2`'s exact shape (or reuse it if the
rehearsal hasn't been consumed) with `TargetTablePrepMode: TRUNCATE_BEFORE_LOAD`
— never `DROP_AND_CREATE`, which wipes the RLS parity restored in Step 0
(already done, see status doc's 2026-09-19 addendum: 606 tables / 1,061
policies, matching Supabase). Start it:

```bash
aws dms start-replication-task --region eu-central-1 \
  --replication-task-arn <the-final-run-task-arn> \
  --start-replication-task-type reload-target
```

Poll until `FullLoadProgressPercent: 100` and `TablesErrored: 0` (or a
known, already-flagged exception — see Steps 1-2 above):

```bash
aws dms describe-replication-tasks --region eu-central-1 \
  --filters Name=replication-task-arn,Values=<the-final-run-task-arn> \
  --query 'ReplicationTasks[0].ReplicationTaskStats'
```

### Step 6 — Verify before flipping anything

- Row-count spot-check the highest-risk tables against Supabase directly
  (`profiles`, `chat_messages`, `app_users`, `oasis_events` — expect
  `oasis_events` to differ slightly if Supabase is somehow still receiving
  writes anywhere, which would itself be a freeze-leak worth investigating).
- Re-confirm RLS parity held through this run (606/1,061, or higher if
  schema changed) — `TRUNCATE_BEFORE_LOAD` should not touch policies, but
  confirm rather than assume.
- If the pgvector/`products`/`knowledge_docs` gaps from Steps 1-2 weren't
  closed, confirm they're still the *only* known gaps.

### Step 7 — Flip connection strings

1. Gateway: `SUPABASE_URL` on the live ECS task definition(s) →
   the PostgREST-Aurora proxy's internal URL. Runtime env var, no redeploy,
   takes effect on next request. Deploy via the canonical
   `AWS-*-DEPLOY-GATEWAY.yml` per this repo's own deployment rules — never
   a manual `aws ecs update-service` outside CI.
2. Frontend: if repointing in this same window, this needs a build +
   deploy through `exafyltd/vitana-v1`'s staging→PUBLISH pipeline — this
   is NOT instant like the gateway's env var, budget real time for it or
   explicitly decide to fast-follow it after the freeze ends (accepting a
   short split-brain window if so — flag this decision either way).

### Step 8 — Unfreeze

```bash
psql "$AURORA_ADMIN_URL"
\i scripts/aws/aurora-cutover-restore-grants.sql
```

Restores the exact pre-freeze grants (4,174 precise `GRANT` statements,
generated from Supabase's live `information_schema.role_table_grants` —
deliberately not a blanket re-grant, which would widen `anon`'s/
`authenticated`'s write footprint beyond what existed before).

---

## Post-cutover

### Step 9 — Verify production is actually serving Aurora

Per this repo's own Deployment Verification Protocol (§15 of CLAUDE.md):
curl a critical endpoint, confirm JSON not HTML, confirm the `env` field
reads correctly, check ECS deployment status.

### Step 10 — Housekeeping (non-urgent, do whenever convenient)

Delete the now-redundant DMS *tasks* (not the replication instance) once
their purpose is served — **do not do this without a live human's explicit
go-ahead**, even though the status doc already recommends it as safe
cleanup; deleting AWS resources is a destructive action and needs
in-the-moment confirmation, not standing pre-approval from an earlier note:

```bash
aws dms delete-replication-task --region eu-central-1 \
  --replication-task-arn arn:aws:dms:eu-central-1:472838866351:task:7KLLMH3EXJGVPEFRP7M33CVA7Q   # vitana-fullload-rehearsal, never started
aws dms delete-replication-task --region eu-central-1 \
  --replication-task-arn arn:aws:dms:eu-central-1:472838866351:task:VWJEA6Z5DFCJLNGD5O4B4YBQYE   # vitana-fullload-rehearsal-v2, already consumed
```

### Step 11 — The actual cost objective

Only once Steps 1-9 are verified stable: downgrade Supabase's own
subscription/compute add-on to free tier. This is the entire point of the
migration, cost-wise — do not do it before Aurora is confirmed serving
real traffic correctly.

### Step 12 — Continue independently, unblocked by any of the above

- Storage (`STORAGE_PROVIDER=s3`) and Edge Functions migration legs.
- Whatever mechanism keeps the 11 "exclude-done" tables (`memory_items`,
  `memory_facts`, `products`, `calendar_events`, etc.) in sync was never
  identified in this repo — if it's still pointed at Supabase post-cutover,
  it needs to be found and repointed at Aurora (or retired).
- `dev_autopilot_prompt_learnings` — exists in Aurora, not in Supabase;
  never investigated, flagged so it isn't lost.

---

## If the deadline slips

This is a bounded write-freeze cutover, not an irreversible one-way door —
if Steps 1-3 aren't ready by 22:00 CET, the honest options are: (a) push
the window to whenever they are ready, or (b) proceed with the two known
gaps (pgvector tables, `products`/`knowledge_docs` uncertainty) explicitly
accepted and documented, backfilling them after. Either is better than
freezing writes before the pre-freeze steps are actually done — a freeze
with no clear unblock plan just extends downtime for no benefit.
