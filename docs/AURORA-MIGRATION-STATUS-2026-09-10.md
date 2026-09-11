# Aurora migration — live status, 2026-09-10 (VTID-03811)

**Superseding note:** `AURORA-MIGRATION-SCOPE.md` (2026-08-10) and
`AURORA-EXCEPT-AUTH-ASSESSMENT.md` (2026-08-05) are now over a month stale.
This doc re-measures the same questions against **live AWS + Supabase state
today**, with real credentials (`arn:aws:iam::472838866351:user/claude-code-aws-agent`),
because the 7-day-cutover directive needs a current picture, not a
month-old one. Both older docs stay as historical record — do not delete.

---

## 1. The headline: still not cut over, and CDC is still broken

Nothing here has changed since 2026-08-10 in the way that matters most:

- **Production gateway task def (`vitana-gateway-awsdr`) still points 100% at
  Supabase** — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE`/`SUPABASE_JWT_SECRET`/
  `SUPABASE_ANON_KEY` secrets, **no** `AURORA_DATABASE_URL`/`DATABASE_URL`.
  Confirmed via `aws ecs describe-task-definition` today.
- **No PostgREST-on-Aurora service is deployed.** `services/postgrest-aurora-proxy/`
  exists in this repo as source/SQL scripts only — there is no
  `postgrest-aurora-proxy` (or similarly named) entry in `aws ecs list-services
  --cluster Vitana-ECS-Cluster` today.
- **DMS CDC replication (`vitana-supabase-to-aurora-v3`) is `failed`,** and both
  of its known root causes were re-tested live today and are **still both
  broken, unchanged from VTID-03804 (2026-09-02):**
  1. Direct hostname `db.inmkhvwdcuyhnxkgfvsb.supabase.co` resolves IPv6-only
     (`2a05:d016:...`, confirmed again via `getent`/`socket.getaddrinfo` from
     this container and via a live `dms test-connection` — `Network is
     unreachable`). This AWS IAM identity has **zero `ec2:*` permissions**
     (`DescribeVpcs`/`DescribeNatGateways`/`DescribeEgressOnlyInternetGateways`
     all `UnauthorizedOperation`) — cannot fix VPC egress from here.
  2. The pooler path (`aws-0-eu-north-1.pooler.supabase.com`) **is** reachable
     over plain IPv4 today (`13.60.109.208`/`16.16.102.12` — confirmed via
     `socket.getaddrinfo`), so this is **not** a network problem. It fails
     purely on Supavisor's own tenant registry: `FATAL: (ENOTFOUND) tenant/user
     migrate.inmkhvwdcuyhnxkgfvsb not found`. The `migrate` Postgres role
     itself is fine (`rolcanlogin=true, rolreplication=true`, confirmed via
     `pg_roles`) — this is Supabase-platform-side pooler configuration, not
     fixable via SQL, Secrets Manager, or any Supabase MCP tool available to a
     Claude Code session. **This is now the third independent session
     (2026-08-29 x2, 2026-09-02, 2026-09-10) to hit the identical error.**
     Unblocking needs a human with the Supabase dashboard/Management API, to
     either re-provision that pooler user or connect DMS via the standard
     `postgres.<project_ref>` pooler identity instead.

**Do not re-attempt either fix from a Claude Code session again without new
access** (EC2 permissions, or Supabase dashboard/Management API). Re-testing
the same two paths a fourth time will reproduce the same two errors.

---

## 2. New, previously-undocumented findings

Real infrastructure exists that no doc (including the stale ones above)
described, discovered by listing live ECS services today:

- **`vitana-auth-proxy`** — ECS service, task def revision 5, steady-state,
  `ACTIVE`, `desired=1 running=1`. Env vars point at the Aurora **reader**
  endpoint, an RDS Proxy endpoint (`vitana-rds-proxy-prod.proxy-...`), and
  Redis (`vitana-redis-prod`). Image: `vitana/auth-proxy:latest` in ECR.
  **No source for this exists in `vitana-platform` or `vitana-v1`** — it may
  be genuine B4 (identity) progress built out-of-band, or one of the
  "mystery services" CLAUDE.md §1b already warns about from the 2026-07-09
  bulk-provisioning event. **Do not assume it reflects any tracked commit or
  extend it blindly** — per CLAUDE.md's own hard rule, a live service outside
  the §1b table needs its own VTID and a confirmed source before being
  trusted. Flagging for the platform owner to say what it is.
- A wider live ECS inventory also shows ~15 other services
  (`vitana-conductor`, `vitana-planner-core`, `vitana-validator-core`,
  `vitana-qa-agent`, `vitana-worker-core`, `vitana-crewai-*`,
  `vitana-cognee-extractor`, `vitana-memory-indexer` x2,
  `vitana-openclaw-bridge`, `vitana-cloudshell-relay`, `vitana-github-sync-service`,
  `vitana-dev-console-ui`, `vitana-oasis-approval`, `vitana-test-agent`)
  none of which appear in CLAUDE.md §1b/§2 either. Out of scope for this VTID
  to audit — noted so a future session doesn't have to rediscover it from
  scratch.

## 3. DMS full-load progress (real, and better than the 08-10 snapshot)

`vitana-supabase-to-aurora-v3`'s last completed full load reached **564 of
566 tables loaded, 2 errored** before CDC failed to start (the same two
network/tenant issues above). That is real, substantial data in Aurora today
— just frozen at whatever point the full load + the manual catch-up syncs
(VTID-03804, 2026-09-02) last ran, plus organic drift since.

**Measured drift today** (Supabase vs Aurora row counts, three sample tables):

| Table | Supabase | Aurora (before fix) | Gap |
|---|---|---|---|
| `app_users` | 208 | 198 | **10 rows — now closed, see §4** |
| `chat_messages` | 43,768 | 43,327 | 441 rows, not synced this session |
| `user_notifications` | 75,566 | 71,760 | 3,806 rows, not synced this session |
| `oasis_events` | 480,141 | 528,592 | Aurora **ahead** by 48,451 — see below |

`oasis_events` being ahead in Aurora (not behind) is worth a flag, not a fix:
it suggests either a separate write path already lands some events directly
in Aurora, or Supabase-side retention/pruning removed rows Aurora still
holds. Not investigated further here — do not blindly "resync" this table by
overwriting Aurora from Supabase, since Aurora may hold rows Supabase no
longer does.

## 4. Fixed this session: `app_users` identity drift closed

`AURORA-EXCEPT-AUTH-ASSESSMENT.md` (2026-08-05) flagged **7 `auth.users`-side
rows missing from `app_users`** as a live bug that must not be carried into
any FK-anchor decision (§"Second problem"). That drift had grown to **10
rows** by today. Closed via the same manual-sync method VTID-03804
established (Supabase MCP read of the exact missing rows by `user_id` diff,
RDS Data API `batch-execute-statement` with typed named parameters and casts
— no FK constraints exist on `app_users` in Aurora today, confirmed via
`pg_constraint`, so this was a plain insert). **Aurora `app_users` is now
208/208, exactly matching Supabase.** This does not fix the underlying cause
(CDC still isn't running, so this table will drift again) — it is a point-in-
time correction of the specific number the Aug 5 doc used to justify urgency
around the FK-anchor decision.

## 5. Reality check against the 7-day cutover deadline

Given everything above, a full Supabase→Aurora cutover (data + auth off
Supabase, Option B from `SUPABASE-TO-AURORA-MIGRATION-PLAN.md`, or even the
narrower "Aurora for everything except auth" from
`AURORA-EXCEPT-AUTH-ASSESSMENT.md`) **is not achievable in 7 days** from this
session's access level, for reasons that are infrastructure/access
blockers, not effort:

1. **Phase 0 (trustworthy Aurora copy) cannot close.** Its own exit
   criterion — CDC running clean for a measured period — needs the Supavisor
   tenant fix or the EC2/VPC fix above, neither reachable from a Claude Code
   session. This has now been independently re-confirmed 3 times across 3
   different sessions over 9 days.
2. **The actual traffic cutover has not started.** Production still speaks
   PostgREST-to-Supabase for every one of ~2,480 call sites; no seam,
   PostgREST-on-Aurora proxy, or gateway config exists in production to
   redirect any of that traffic today.
3. **Auth (B4) has not been scoped into working code** — 116 FKs into
   `auth.users`, 557 RLS policies referencing `auth.uid()`, 201 user
   credentials — `AURORA-EXCEPT-AUTH-ASSESSMENT.md`'s own three open
   questions (FK strategy, frontend-rewrite scope, Realtime replacement) are
   still open a month later, and the discovered `vitana-auth-proxy` service
   (§2) is unverified, unowned-in-git infrastructure that cannot safely be
   assumed to solve this.

**What is achievable in 7 days, and what this session recommends spending
them on:**

- Escalate the two DMS blockers to whoever has AWS console EC2 access or
  Supabase dashboard access — this is a 10-minute human fix once someone
  with the right access looks at either the Supabase Network Restrictions /
  connection pooler settings, or grants this IAM identity `ec2:Describe*`
  read access to identify a VPC endpoint or NAT path.
- Keep advancing the B1–B3/B6/B7 code-side workstreams (data-access seam,
  dead-callsite cleanup, RPC parity, storage, edge functions) that do not
  depend on DMS or EC2 — real progress here shrinks what has to happen on
  cutover day, whenever that is.
- Do NOT flip any traffic at the gateway to Aurora before Phase 0 closes —
  doing so on a stale, silently-drifting copy (as this session's own
  `app_users` finding shows can reach double digits within a month) risks
  exactly the "confidently wrong" failures CLAUDE.md's Never-rules exist to
  prevent.

## Addendum, 2026-09-11, VTID-03815 continuation — `vitana-auth-proxy` resolved: confirmed orphaned, not usable B4 progress

§2 above flagged `vitana-auth-proxy` as possibly-real, out-of-band B4
(identity) work, and asked the platform owner to say what it is. This
session has live AWS credentials again — checked directly rather than
leaving it as an open question a second time.

**Confirmed orphaned — three independent signals, not one:**

1. **No ingress path exists at all.** `aws ecs describe-services` shows
   `loadBalancers: []` (no ALB target group — confirmed separately that no
   `elbv2` target group with "auth" in its name exists anywhere in this
   account) and `serviceRegistries: []` (no Cloud Map / internal service
   discovery either). `assignPublicIp: DISABLED` on a private-subnet
   Fargate task with neither of those wired means **no other AWS resource,
   gateway included, has any DNS name or IP address to reach this service
   with.** It cannot be receiving real traffic from anything in this
   account, regardless of what code is inside it.
2. **`createdAt: 2026-07-09 13:25:07 UTC`** — this is not an approximate
   match, it is the exact date of the "unexplained 2026-07-09
   bulk-provisioning event" CLAUDE.md's own AWS-prod hard-rules section
   already names as the source of "~17-22 still-unexplained mystery
   services" (same event `orb-agent`'s pre-existing infrastructure traces
   back to). This is one more instance of that event, not a separate,
   deliberate B4 effort.
3. **Its logs confirm it does nothing after boot.** `/vitana/auth-proxy`'s
   log group has one stream per task run; every stream's first and last
   event timestamp are within ~1 second of each other, across every run
   checked (2026-07-22 through 2026-09-10, 5+ restarts) — meaning each
   container logs exactly two lines (`@supabase/supabase-js`'s Node 18
   deprecation warning, then a bare `"Auth Proxy started"`) and then never
   logs again for the rest of its lifetime, sometimes days. No access
   logs, no request logs, no errors — consistent with a service that never
   receives a single inbound request, matching finding 1 above rather than
   contradicting it.

**What it has, for the record, in case it's ever revived deliberately:**
real credentials for both databases this migration cares about —
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` (Secrets Manager) and Aurora
(`DB_HOST` → the RDS Proxy endpoint, `DB_READER_HOST` → the Aurora reader,
`DB_PASSWORD` → the RDS-managed rotation secret) plus Redis — a
credentials shape that DOES look like it was intended for something
identity/proxy-shaped bridging the two databases. That plausible intent is
exactly why this needed confirming rather than assuming either way: it
looked like it could have been real B4 progress, and it looked like it
could have been an abandoned mystery service, and only checking reachability
and logs (not just credentials) could tell the two apart.

**Conclusion: do not treat this as existing B4 progress, do not extend it,
and do not route any real traffic at it.** It has no source in either
tracked repo (unchanged from §2's original finding), no way to receive
traffic today, and no evidence it has ever processed a single request
since it was created. Per CLAUDE.md's own hard rule ("a live AWS resource
[is not] governed just because it exists... extending to a new service
needs its own VTID"), reviving it would need its source recovered or
rewritten from scratch, its own VTID, and a real ALB/service-discovery
wiring decision — not a resumption of unknown prior work. No action taken
on the service itself (not stopped, not modified) — this addendum is
read-only investigation, the same posture as the rest of this migration
effort's live-infrastructure checks.

## Addendum, 2026-09-11 continued — the full 2026-07-09 mystery-service roster, finally named and classified

`vitana-auth-proxy` was one instance of a pattern this file's §2 only
gestured at ("~15 other services... none of which appear in CLAUDE.md
§1b/§2"), and `docs/AWS-PRODUCTION-BUILD-LOG.md` had already independently
put a rougher number on the same event ("29 ECS services... plus ~17
services with no counterpart"). Enumerated the full ECS cluster (`aws ecs
list-services`, 32 services total) and pulled `createdAt` for every one
via a single batched `describe-services` pass (not per-service spot
checks, which is how this session's own first version of this addendum
undercounted) — **exactly 27 services share the identical `createdAt`
window (1783603505.429–1783603508.299, a 2.87-second span, 2026-07-09)**,
against 5 services created weeks later via real, deliberate deploys
(`vitana-gateway-awsdr`, `vitana-community-app-awsdr`,
`vitana-oasis-operator-awsdr`, `vitana-gateway`,
`vitana-community-app-staging`). **Correction to this addendum's own
first draft, caught before merge: it originally said "21 services" — a
real undercount**, from checking a curated list rather than sorting the
full cluster by `createdAt`. The precise number is **27**, of which **4
already have a CLAUDE.md §1b entry and a deploy pipeline added after the
fact** (`vitana-orb-agent`, `vitana-oasis-projector`,
`vitana-worker-runner`, `vitana-vitana-verification-engine` — the same
"pre-existing, deploy pipeline added on top" shape CLAUDE.md already
documents for `orb-agent` specifically) and **23 remain completely
undocumented anywhere**, all with zero ALB target group and zero Cloud Map
service discovery — nothing in this account can address any of them by
name or IP. Full 23-name roster: `vitana-auth-proxy`, `vitana-conductor`,
`vitana-planner-core`, `vitana-validator-core`, `vitana-qa-agent`,
`vitana-worker-core`, `vitana-cognee-extractor`, `vitana-oasis-approval`,
`vitana-test-agent`, `vitana-dev-console-ui`, `vitana-github-sync-service`,
`vitana-cloudshell-relay`, `vitana-mcp-gateway`, `vitana-oasis-mcp-v2`,
`vitana-vitana-dev-gateway`, `vitana-memory-indexer`,
`vitana-vitana-memory-indexer`, `vitana-openclaw-bridge`,
`vitana-crewai-kb-agent`, `vitana-crewai-prompt-synth`,
`vitana-lifetime-context-crew`, plus two that are easy to miss because
their names collide with real production services: **`vitana-community-app`**
and **`vitana-oasis-operator`** (bare, no `-awsdr`/`-staging` suffix) are
ALSO July-9 orphans, distinct from the real, ALB-fronted
`vitana-community-app-awsdr`/`-staging` and `vitana-oasis-operator-awsdr`
created weeks later — `docs/AWS-PRODUCTION-BUILD-LOG.md` already flagged
this specific pair by name at the time of the original 2026-07-27
build, which this pass independently re-confirms rather than discovers
fresh. **This is the exact "vitana-gateway vs vitana-gateway-awsdr"
name-collision trap CLAUDE.md's own AWS-prod hard rules already warn
about, for two more service names it doesn't yet mention** — worth
adding there.

**Correcting my own prior read: "unreachable" is not the same claim as
"orphaned," and I initially conflated them.** Checked log activity (not
just reachability) for every one of the 23 undocumented services before
generalizing from `auth-proxy`'s specific finding, since a background
worker legitimately polling outward (the same shape CLAUDE.md already
documents for `worker-runner`/`oasis-projector`) would correctly show no
ALB and still be doing real work. The 23 split cleanly into two groups:

- **Group A — genuinely dormant, same shape as `auth-proxy`** (a log
  group with only isolated single-moment bursts, first≈last timestamp on
  every stream, no sustained activity ever): `vitana-auth-proxy`,
  `vitana-dev-console-ui`, `vitana-github-sync-service`,
  `vitana-mcp-gateway`. 4 services.
- **Group B — alive and running stable, sustained workloads for weeks at
  a time**, confirmed by real multi-day-to-multi-week log streams and, for
  `vitana-conductor` specifically, actual log content read directly
  (`gunicorn`/`uvicorn` FastAPI, listening on 8080 — consistent with every
  task definition's port mapping): `vitana-conductor`,
  `vitana-planner-core`, `vitana-worker-core`, `vitana-validator-core`,
  `vitana-qa-agent`, `vitana-crewai-kb-agent`, `vitana-crewai-prompt-synth`,
  `vitana-lifetime-context-crew`, `vitana-oasis-approval`,
  `vitana-cloudshell-relay`, `vitana-test-agent`, `vitana-oasis-mcp-v2`,
  `vitana-vitana-dev-gateway`, `vitana-memory-indexer`,
  `vitana-vitana-memory-indexer`, `vitana-cognee-extractor`,
  `vitana-community-app`, `vitana-oasis-operator`, `vitana-openclaw-bridge`
  (already independently confirmed reachable-only-by-manual-dispatch in
  `AURORA-B3-RPC-PARITY-INVENTORY.md`'s §5). 19 services (revised from an
  earlier miscount of "16" before `openclaw-bridge`/the two bare-named
  services were folded in).

**What Group B is actually computing is not established here — a real,
important limit on this finding.** These processes are alive, costing
real Fargate spend continuously since mid-July, and have zero external
ingress path, so whatever they do must be either outbound (polling some
external API, writing to a database, talking to another AWS resource) or
genuinely inert work in a loop — this pass did not trace any of their
outbound calls, IAM role permissions, or task-definition secrets/env vars
beyond `auth-proxy`'s and did not read enough log content from the other
18 to characterize their actual behavior. The names (`conductor`,
`planner-core`, `validator-core`, `qa-agent`, `worker-core`, `crewai-*`)
strongly suggest an autonomous multi-agent pipeline distinct from the
documented worker-runner/autopilot-executor system, but that is a
plausible reading of the names, not a confirmed finding — do not repeat
it as fact without independently verifying it.

**Recommendation, not a decision:** every one of these 23 (and Group A's 4
in particular, which do nothing detectable at all) is a real, standing
question for the platform owner — keep running at real cost with unknown
purpose, or investigate each one's actual container image/source and
either bring it under governance (its own VTID, source recovered into a
tracked repo, explicit CLAUDE.md entry) or decommission it. Per CLAUDE.md's
own rule, a live AWS resource is not governed just because it exists, and
that cuts both ways here: this session neither assumes these are safe to
delete nor assumes they matter — it only establishes, for the first time
with names and evidence instead of an approximate count, exactly what is
running and what state it's actually in. No action taken on any of the 27
July-9-batch services (none stopped, none modified) — read-only
investigation only.

## Addendum, 2026-09-11 continued — this is a credentials-exposure finding, not just a naming/governance one

Checked task-definition `secrets` (not just `environment`, which was as far
as the `auth-proxy` writeup above went) for six of the Group B services —
`vitana-conductor`, `vitana-planner-core`, `vitana-worker-core`,
`vitana-validator-core`, `vitana-qa-agent`, `vitana-crewai-kb-agent`,
`vitana-oasis-approval`. **Every single one carries the exact same three
secrets:** `DB_PASSWORD` (the RDS-managed master password for
`vitana-aurora-prod`, ARN
`rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2`),
`SUPABASE_URL`, and **`SUPABASE_SERVICE_ROLE`** — the production Supabase
service-role key, which bypasses RLS entirely and has unrestricted
read/write on every table in the production database. This is the exact
same secret this session was denied when attempting the B6 private-storage
backfill (`vitana/supabase/prod/service-role-key`, blocked by an explicit
IAM permissions-boundary deny on this session's own identity) — meaning
**these 19+ unsourced, undocumented, ungoverned services hold a
higher-privilege credential to the production database than this Claude
Code session itself is permitted to use.**

**What is and isn't established:** the `environment` block on
`vitana-conductor`/`vitana-planner-core`/`vitana-worker-core`/
`vitana-validator-core` also points `DB_HOST`/`DB_READER_HOST` at the real
`vitana-aurora-prod` RDS Proxy/reader endpoints and `REDIS_HOST` at
`vitana-redis-prod`, with `ENV=prod`. `vitana-qa-agent` is the one
exception found so far — its `DB_HOST`/`DB_READER_HOST`/`REDIS_HOST` point
at a **previously undocumented standalone RDS instance,
`vitana-postgres-staging`** (confirmed live via `aws rds
describe-db-instances`: engine `postgres`, status `available` — this is
NOT part of the `vitana-aurora-prod` Aurora cluster and appears nowhere in
CLAUDE.md), with `ENV=staging`. This session did **not** confirm these
processes actually issue any Supabase or Aurora queries — the log content
read for `vitana-conductor` (above) was gunicorn/uvicorn INFO-level
startup output only, with no visible query activity, and this pass did
not attempt to trace outbound network calls, enable RDS/Supabase
data-plane audit logging, or inspect the container image's actual code.
**Holding a valid, wired, production-grade credential is the confirmed
fact; whether it is being actively exercised is not.**

**Why this matters regardless of that distinction:** an unaccounted-for
service holding the production service-role key is a real security-hygiene
gap on its own terms — if these processes are ever compromised, misused,
or simply behave unexpectedly, nothing about their current dormant-looking
log output prevents them from reading or writing arbitrary rows in
production Supabase, RLS notwithstanding. This is a materially different,
more urgent framing than "unexplained infrastructure cost," and is worth
surfacing to the platform owner as its own item, separate from the
broader governance/cost question above — specifically: whether this
credential exposure is intentional (a real, deliberate multi-agent
pipeline someone built and forgot to document) or an oversight from the
2026-07-09 provisioning event that should prompt rotating
`vitana/supabase/prod/service-role-key` once these services are
understood or decommissioned. Not resolved here — flagging with the exact
evidence rather than either alarming unnecessarily or under-stating it.
