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
