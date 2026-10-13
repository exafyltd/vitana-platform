# Supabase → Aurora Cutover Runbook — 2026-09-21 14:00 CEST


> **UPDATE 2026-10-05 (VTID-04755) — read before the 2026-10-10 00:00 CEST window.**
> - The Aurora cluster was restored from backup (2026-10-01) after a KMS key-access
>   loss; endpoints are unchanged. New RDS-managed master secret:
>   `rds!cluster-4dab93b8…` — the old `rds!cluster-eba8a4f2…` ARNs below are dead.
> - The freeze (Step 4) and restore-grants (Step 8) scripts run on **Supabase**,
>   not Aurora (their own headers say so); the psql lines below are corrected.
> - Aurora-side SQL runs through the RDS Data API with
>   `scripts/aws/aurora-run-sql.sh <file>` (needs `aws rds enable-http-endpoint`).
> - **Step 1 is superseded** by `aurora-cutover-vector-preload.sql` (before the
>   load: calendar_events `valid_source_type` synced to Supabase, vector indexes
>   dropped, 13 vector columns staged as text) and
>   `aurora-cutover-vector-postload.sql` (after the load: cast back, recreate
>   indexes). The 2026-10-05 rehearsal failed exactly these tables without it.
> - **New Step 5b**, after the final load: `aurora-cutover-vector-postload.sql`,
>   then `aurora-cutover-recreate-foreign-keys.sql` (355 FKs; Aurora had 0, so
>   PostgREST embedded selects would fail). Must run AFTER the load — TRUNCATE
>   fails on FK-referenced tables.
> - The final load uses task `vitana-fullload-final-catchup`
>   (`arn:aws:dms:eu-central-1:472838866351:task:HBS7QKNHKFFT5GK6WDMK5236CA`).
> - **UPDATE 2026-10-09: schema drift.** A full column diff showed Aurora is
>   missing 79 columns, 8 tables and 20 views that Supabase has (later
>   migrations never reached Aurora). **New Step 0**, before the pre-load:
>   `aurora-cutover-schema-sync.sql`. **New last step**, after the FKs:
>   `aurora-cutover-schema-sync-views.sql`. Both can be re-run, and both were
>   tested twice against a scratch Postgres built from Aurora's real columns.
>   `signup_funnel` is not created: it joins `auth.users`, which Aurora does
>   not have. Still open: 16 enum columns that are varchar on Aurora, and 2
>   nullability differences. `aurora-cutover-fix-6-tables.sh` runs every step
>   in order.
> - **Embedding backfill (new step after `aurora-cutover-after-load.sh`):**
>   `python3 aurora-cutover-embedding-backfill.py`. It reads Supabase read-only
>   through its REST API (GETs only, service-role key; the DB network allow-list
>   admits only DMS) and writes to Aurora through the Data
>   API, 25 rows per transaction with `session_replication_role = replica`, so
>   no trigger restamps rows. It then compares counts per column, restores the
>   2 NOT NULLs and rebuilds the 3 IVFFlat indexes. It can be re-run. Tested
>   end to end against scratch Postgres: values byte-identical, trigger
>   suppressed.
> - **Embedding backfill, first real run 2026-10-10: passed.** All 7,942 copied
>   in about 4.5 minutes, and the counts match Supabase on all 13 columns. NOT
>   NULL is restored on both columns and the 3 IVFFlat indexes are rebuilt. On
>   the switch night it runs after the freeze, so nothing is missed.
> - **DRESS REHEARSAL 2026-10-09 22:00Z — passed (no connection switch, no
>   freeze).** The full DMS load took 20 min (21:46–22:06Z): 663 tables, 0
>   errors. Then `aurora-cutover-after-load.sh` ran the post-load, 358 FKs and
>   19 views (`ALL DONE`, about 22:45Z after three script fixes). Open before
>   the real switch: (1) **embeddings** — DMS truncated all 7,942 of them on
>   the source read, so Aurora has none. They need a separate backfill from
>   Supabase, after which `NOT NULL` goes back on
>   `dev_agent_memory.embedding` and `memory_embeddings.embedding`;
>   (2) `signup_funnel` view; (3) realtime, storage, edge functions and a
>   public endpoint for the PostgREST proxy; (4) 16 enum columns that are
>   varchar on Aurora.

> **VTID-04880 (2026-10-05):** `nav_catalog`, `nav_catalog_audit` and
> `nav_catalog_i18n` no longer live in Supabase `public`. They were archived
> into the `legacy_archive` schema with the legacy voice navigator
> (migration `20261005090000_vtid_04880_archive_nav_catalog.sql`), so they are
> not part of a `public` load. The restore scripts under
> `services/postgrest-aurora-proxy/` and `scripts/aws/` guard every statement
> on them with `to_regclass(...)`, so a fresh load without the tables runs
> clean. Aurora copies that already exist are left as they are.

**UPDATED 2026-09-20 (second update, supersedes the one below it): the
freeze window was postponed again — from tonight's midnight-CET window to
Monday 2026-09-21 14:00 CET/CEST (12:00 UTC) — per explicit platform-owner
instruction, given after a direct risk review of the write-freeze
mechanism. Recorded for whoever picks this up Monday: the freeze itself
(`REVOKE INSERT, UPDATE, DELETE ON SCHEMA public FROM anon, authenticated,
service_role`) is non-destructive and fully reversible via
`scripts/aws/aurora-cutover-restore-grants.sql` — re-verified byte-for-byte
current against live Supabase grants as of 2026-09-20 22:05 UTC
(4,174/4,174 statements match) — and tonight's plan never repoints
production traffic at Aurora, so there is no path by which production
"can't be turned back on." This postponement is a scheduling choice, not a
response to newly discovered risk. Every rule/step below is otherwise
unchanged.**

**Known open item before Monday's window, not yet resolved:** ECS Exec
into the `postgrest-aurora` proxy task fails with
`TargetNotConnectedException` — `vitana-ecs-task-role` has no
`ssmmessages:CreateControlChannel`/`CreateDataChannel`/`OpenControlChannel`/
`OpenDataChannel` grants, and the VPC has an interface endpoint for `ssm`
but none for `ssmmessages`/`ec2messages` (one NAT gateway exists,
`nat-072e06f231370eceb`, whose reachability from the task's subnets for
this purpose is unconfirmed). Neither gap is fixable from a Claude Code
session's IAM identity (the permissions boundary denies the relevant
`iam:Put*`/`ec2:CreateVpcEndpoint` actions) — needs an admin/owner action.
Until it's resolved, the proxy's functional smoke test (auth passthrough,
REST read, cross-tenant RLS isolation) cannot run. The proxy is otherwise
live and reports `healthStatus: HEALTHY` after the container health-check
fixes in PR #3482 (merged as `f25798c8`) — see
`services/postgrest-aurora-proxy/README.md` for detail.

~~**UPDATED 2026-09-20 (first update, superseded above): the freeze window
was moved from 22:00 CET to midnight CET (00:00 CET, 2026-09-21 = 22:00
UTC, 2026-09-20) per explicit platform-owner instruction.**~~

**This is the execution checklist for the Monday 14:00 CEST window. It
consolidates everything already decided and verified in
`docs/AURORA-MIGRATION-STATUS-2026-09-10.md` (2026-09-18/19/20 addenda)
into one ordered, copy-paste-ready sequence. Read the status doc for the
*why*; read this for the *what, in what order*.**

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

**Update 2026-10-10 (VTID-05023, option B):** the public endpoint is now
built by two governed, `workflow_dispatch`-only workflows instead of by hand:
`AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml` (separate prod service
`vitana-postgrest-aurora-proxy-prod`, task family
`vitana-postgrest-aurora-prod`, pinned `commit_sha`) and
`AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml` (target group, ALB host rule
priority 8, Cloudflare CNAME + WAF/bot skip for `data.vitanaland.com`; refuses
without a PASS privilege-parity report < 24 h old). They supersede the
hand-run draft `scripts/aws/setup-postgrest-aurora-proxy-public.sh`, which was
deleted (hand-run `aws` changes violate rule 17). The staging service
`vitana-postgrest-aurora-proxy` stays staging-only.

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
psql "$SUPABASE_ADMIN_URL"   # SUPABASE (the source), not Aurora -- see the script header
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
policies, matching Supabase).

**Use `scripts/aws/aurora-cutover-final-catchup-task.sh` instead of a
plain clone of `vitana-fullload-rehearsal-v2`** — that task's mapping
still excludes 10 "exclude-done-*" tables (`ai_memory`, `memory_items`,
`memory_facts`, `mem_episodes`, `user_intents`, `memory_embeddings`,
`community_listings`, `calendar_events`, `mem_facts`, `feedback_tickets`)
on the theory that a separate mechanism keeps them in sync with
Supabase. The status doc's 2026-09-12 addenda (7) and (11) settled that
question: those 10 tables have measurably drifted (2-11%) since
whichever earlier ad-hoc effort first loaded them, and NO code path in
this repo (nor anything found in tracked DMS tasks) has written to
Aurora's copies since — the real memory/fact write path
(`write_fact()`) goes straight to Supabase PostgREST. There is no
mechanism to protect by excluding them; the new script removes those 10
rules so Step 5 gives them a genuine final load, same as everything
else. (`products`/`knowledge_docs`, the OTHER two originally-excluded
tables, are a separate, already-closed question — see the "2026-09-20 —
`products`/`knowledge_docs` 'known-broken' question RESOLVED" entry in
the status doc; the script keeps those two excluded, correctly.) Start
it:

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

**Plan Sparring Gate (VTID-04868) — before Step 7/8:** only now, after the
final load has finished, create the `vtid_ledger` gate on Aurora
(`trg_plan_sparring_check` + `vtid_ledger_sparring_id_unique`, from
`supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql`, then
`supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql` —
the 5-arg allocator, plan-hash binding and the 3-arg round append; confirm only
the 5-arg `allocate_global_vtid` and the 3-arg `plan_sparring_append_round`
exist), confirm
`pg_trigger.tgenabled = 'O'` and that `plan_sparring_config.mode` equals
Supabase's. Never create it while DMS is still writing `vtid_ledger`. Details:
`docs/AURORA-B3-RPC-PARITY-INVENTORY.md`, VTID-04868 addendum.

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
psql "$SUPABASE_ADMIN_URL"   # SUPABASE, not Aurora
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

---

## Part 0 — privilege parity gate (VTID-05023)

The PostgREST-Aurora proxy must never give `anon`, `authenticated` or
`service_role` more on Aurora than they have on Supabase (sparring finding
F1: `setup-aurora-postgrest-grants.sh` grants ALL to anon, Supabase's anon
RPC lockdown incl. `increment_wallet_balance` is not on Aurora, tables
without RLS). This gate checks that, and nothing member-facing goes public
until it passes.

**When it runs**
1. **Against the Aurora clone first** (N7): before the staging data host
   serves anything in the part-10 rehearsal, with `--cluster <clone id>`.
2. **Before the public host goes live**: `data.vitanaland.com` stays dark
   until `--check --strict` exits 0 against `vitana-aurora-prod`.
3. **After every final load** (and its after-load / embedding steps), in the
   window, before any flip. A DMS load can recreate tables and so drop RLS
   and grants; a pass from before the load does not count.

**How**
1. Take the Supabase snapshot read-only: run
   `scripts/aws/aurora-privilege-parity-snapshot.sql` (one SELECT, one JSON
   document) and save the result as `supabase-snapshot.json`. A client with a
   small result limit can use the chunked form:
   `python3 scripts/aws/aurora-privilege-parity.py --print-chunk-sql 0:99`
   (save the rows as a JSON list; the script reassembles them and checks the
   md5).
2. Check Aurora (reads the same SQL through the RDS Data API, cluster's
   MasterUserSecret, account/region guarded; the only statement it sends is
   that SELECT):
   ```bash
   python3 scripts/aws/aurora-privilege-parity.py --check --strict \
     --supabase-snapshot supabase-snapshot.json \
     --cluster vitana-aurora-prod --role-map postgres=<aurora owner role> \
     --save-aurora-snapshot aurora-snapshot.json \
     --report docs/validation/VTID-05023/privilege-parity-report.json
   ```
   Exit 1 on any EXTRA grant (table, column, routine, default privilege,
   role membership), any RLS mismatch, any role-setting mismatch
   (`statement_timeout` anon 3s / authenticated 8s) or role-attribute
   mismatch. MISSING only warns without `--strict`; at the public-host and
   window gates always use `--strict`.
3. On failure, write the fix (the script never executes it):
   `... --fix --out privilege-parity-fix.sql` (same inputs, or
   `--aurora-snapshot aurora-snapshot.json`). Review it, run it with
   `scripts/aws/aurora-run-sql.sh privilege-parity-fix.sql` using a
   credential that owns the objects, then **run `--check --strict` again**.
   A REVOKE by a role that is neither owner nor grantor is a silent no-op in
   PostgreSQL, so only the re-check proves the fix landed.

**What it does not change on its own**
- Statements that would make Aurora *less* restrictive (disable RLS where
  Supabase has none, reset a role setting Supabase does not have) are written
  as comments; uncomment after review or pass `--allow-loosen`.
- Objects owned by an extension (pgvector, postgis) are reported, not gated
  (`--include-extension-objects` to gate them). `MAINTAIN` (PG17+) is
  reported, never fixed.
- A table-level REVOKE also removes that privilege's column grants; the fix
  file grants Supabase's column grants back after the REVOKE.

Tests: `python3 -m unittest discover -s scripts/aws/test -p 'test_*.py'`
(fixture catalogs, no network), run in CI by
`AURORA-PRIVILEGE-PARITY-UNIT.yml`.

---

## Part 4 — auth -> Aurora bridge (VTID-05023, sparring F2 / N3 / R2)

GoTrue (`auth.users`) stays on Supabase; `public` moves to Aurora, which has
no `auth.users`. Six AFTER INSERT triggers on Supabase's `auth.users` used to
provision every new member in `public` (see
`docs/validation/VTID-05023/side-effects.md` C). At the flip they are
disabled and the same provisioning runs on Aurora through three idempotent
layers: the PostgREST `db-pre-request` hook (members' own read-write
requests), the `auth.users` webhook -> gateway
`POST /api/v1/internal/auth-bridge/user-event`, and a 5-minute gateway
reconciliation job. The gateway also awaits `ensureProvisioned(userId)` on
its post-sign-up write paths (service-role writes never reach the hook).
`before_auth_user_delete_cleanup_contacts` stays enabled on Supabase.

**Order**
1. Before the prod proxy deploy that carries `PGRST_DB_PRE_REQUEST`
   (`AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml` sets it): run
   `scripts/aws/aurora-run-sql.sh scripts/aws/aurora-cutover-auth-bridge.sql`
   on Aurora (and on the clone for part 10). PostgREST fails every request
   while the function is missing. Re-runnable.
2. In the window, after the schema freeze: export the FK map read-only from
   Supabase and load it on Aurora:
   `psql "$SUPABASE_DB_URL" -X -A -t -f scripts/aws/supabase-auth-fk-map-export.sql > /tmp/aurora-auth-fk-map.sql`
   then `scripts/aws/aurora-run-sql.sh /tmp/aurora-auth-fk-map.sql`. The
   deletion path refuses to run while the map is empty.
3. Gateway (prod task def, with the R1(b) flip): `AUTH_BRIDGE_ENABLED=true`,
   `AUTH_BRIDGE_RECONCILE_ENABLED=true`, `AUTH_BRIDGE_RECONCILE_SINCE=<start
   of the final full load, ISO 8601>` (anyone who signed up after the load
   began may be missing on Aurora: the gap backfill), optional
   `AUTH_BRIDGE_RECONCILE_MAX_DELETES` (default 20). `GATEWAY_SERVICE_TOKEN`
   must be set (the endpoint refuses every call otherwise).
4. Supabase Vault: `auth_bridge_gateway_url` (prod gateway base URL) and
   `auth_bridge_service_token` (the prod `GATEWAY_SERVICE_TOKEN`), then run
   `scripts/aws/supabase-cutover-auth-bridge.sql` on Supabase (one
   transaction; it verifies 6 triggers disabled and 4 enabled before
   COMMIT). Users who signed up after the final load began, including
   between the trigger switch and the gateway flip, are picked up by the
   reconciler (`SINCE`).
5. Verify read-only: the gateway logs `auth-bridge reconcile: N auth users,
   provisioned 0, deleted 0` every 5 minutes; no `ensure_provisioned failed`.

**Rollback**: `scripts/aws/supabase-cutover-auth-bridge-rollback.sql` on
Supabase (re-enables the six triggers, drops the bridge triggers), and set
`AUTH_BRIDGE_ENABLED` / `AUTH_BRIDGE_RECONCILE_ENABLED` back to false.

**Known gap to resolve before the window (not part 4)**:
`erase_user_data()` (VTID-04765, account deletion) references
`'auth.users'::regclass`; on Aurora that raises, so account deletion's
erasure step fails there until the function is adapted.

Tests: `npm run test:auth-bridge` (throwaway Postgres; CI
`SQL-AUTH-BRIDGE.yml`) and
`npx jest test/vtid-05023-auth-bridge-*.test.ts` in `services/gateway`.

## Part 8 — migrations (VTID-05023)

`RUN-MIGRATION.yml` and `MIGRATION-DRIFT-CHECK.yml` choose their database
from the repo variable `MIGRATION_TARGET` (`supabase` when unset — the
Supabase path is unchanged) or the dispatch input `target`
(`default`/`supabase`/`aurora`; anything but `default` overrides the
variable). On `aurora`:

- `RUN-MIGRATION.yml` prints the statement plan with no credentials
  (`scripts/aws/aurora-apply-migration.sh --dry-run`), then assumes
  `AWS_PROD_ROLE_ARN` over OIDC and applies the file over the RDS Data API:
  all statements in one Data API transaction; any failure (also at COMMIT)
  rolls back and fails the run naming the statement; then
  `NOTIFY pgrst, 'reload schema'`. Files with psql meta-commands
  (`\set ...`) or a top-level `ROLLBACK` are refused; `CREATE INDEX
  CONCURRENTLY` and other non-transactional statements need a file of their
  own or the `allow_non_transactional` input (statement by statement, no
  rollback).
- `MIGRATION-DRIFT-CHECK.yml` reads the same public-table inventory as
  `ci_schema_inventory()` from Aurora with one read-only SELECT over the
  Data API and checks it against the same baseline. Pull-request runs need
  the OIDC role's trust policy to accept this repo's pull_request subject;
  otherwise they fail at the credentials step while the target is `aurora`.
- `APPLY-FB061-DEBOUNCER-FIX.yml` applies no SQL and is unchanged.

**Order in the window**
1. **Schema freeze** — at the start of the final load (Step 5), after
   checking that no `RUN-MIGRATION` run is in progress:
   `gh variable set MIGRATION_FREEZE --body true --repo exafyltd/vitana-platform`.
   Both workflows then fail fast, for either target: no migration is applied
   between the final load and the flip, so the loaded schema is the schema
   that goes live.
2. **DDL watch** — after the final load has finished, as the master user
   (needs `rds_superuser`):
   `scripts/aws/aurora-run-sql.sh scripts/aws/aurora-pgrst-ddl-watch.sql`.
   Idempotent. Verify read-only:
   `SELECT evtname, evtevent, evtenabled FROM pg_event_trigger WHERE evtname LIKE 'pgrst%'`
   → `pgrst_watch` (ddl_command_end) and `pgrst_drop_watch` (sql_drop), both `O`.
3. **Flip** (with Step 7):
   `gh variable set MIGRATION_TARGET --body aurora --repo exafyltd/vitana-platform`.
4. **Unfreeze** (with Step 8):
   `gh variable delete MIGRATION_FREEZE --repo exafyltd/vitana-platform`.
   Dispatch the drift check once by hand
   (`gh workflow run MIGRATION-DRIFT-CHECK.yml --repo exafyltd/vitana-platform -f target=aurora`)
   and see it green before the nightly run relies on it.

**Rollback**: `gh variable delete MIGRATION_TARGET` (back to supabase). The
event triggers can stay; to remove them:
`DROP EVENT TRIGGER IF EXISTS pgrst_watch; DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;`.

**Limits**: `ALTER TYPE ... ADD VALUE` runs inside the transaction (PG ≥ 12),
but the new value cannot be used before COMMIT — split such a file in two.
One Data API call is limited to 45 s and 64 KB of SQL; a longer statement
fails the run and rolls back.

Tests: `npm run test:aurora-migrations` (throwaway Postgres and a fake
`aws`; the splitter is also compared with psql on 15 real migration files).
