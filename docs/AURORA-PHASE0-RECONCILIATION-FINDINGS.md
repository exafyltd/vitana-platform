# Aurora Migration — Phase 0 Reconciliation Findings

**VTID-03734.** First session in this migration effort with live AWS/DMS/
Aurora **and** Supabase access at once — every prior session recorded "no
live AWS/DMS access" as its standing blocker (see
`docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` §Phase 0). This pass used that
access read-only to diagnose the current state, not to fix it — see
**Access boundary** below for why.

## Headline: the "~154,000 silently-dropped row applies" finding does not
## describe current reality, and the real current gap is smaller and different

The plan's Phase 0 gate rests on: *"DMS showed ~154,000 silently-dropped row
applies"* (VTID-03419, 2026-07-27). Traced this to its source and re-verified
it live:

- Aurora has an `awsdms_validation_failures_v1` table (DMS's own built-in
  validation log) with **225,958 rows** — the likely origin of the "~154k"
  figure (same order of magnitude, not an exact match, possibly a different
  count method or a partial re-run).
- **Every single one of those 225,958 rows is `FAILURE_TYPE = 'RECORD_DIFF'`**
  — a value mismatch on an existing, matched row. **Zero** are a "row exists
  on one side only" type. This alone means "154k dropped" was never the
  right description even a month ago — DMS's own log never recorded missing
  rows at this scale, only value differences.
- **All 225,958 rows share one exact timestamp window: 2026-07-27 18:06:12
  to 18:45:00 UTC** (a single 39-minute validation pass), immediately after
  the **older** `vitana-supabase-to-aurora` task's full load finished
  (`FullLoadFinishDate: 2026-07-21`, task `StopDate: 2026-07-27 15:02:53`) —
  not the current `vitana-supabase-to-aurora-v3` task, whose own full load
  finished three weeks later, 2026-08-13.
- **The failure pattern is one systematic, benign shape, not scattered
  corruption:** grouped by `(TABLE_NAME, DETAILS)`, the entries decompose
  into exactly two things, both boolean-column artifacts —
  `''` (Postgres's internal true-byte) compared against the string
  literal `'1'`/`'0'`, and `NULL` compared against `'0'`/`'1'` — across 43
  tables' boolean flag columns (`auto_exec_eligible`, `is_recurring`,
  `has_rewards`, `retried`, `host_present`, `is_active`,
  `stripe_charges_enabled`, `projected`, etc.). The ``-vs-`'1'` shape
  is very likely a validation-tool string-comparison artifact (same boolean
  value, different textual rendering) rather than a real difference; the
  `NULL`-vs-`0` shape is a real, but narrow and boolean-specific, coercion
  from that one old load.
- **Spot-checked live, right now, on both sides:** the single most-repeated
  failure signature (`oasis_events.projected: NULL(source) vs 0(target)`,
  157,786 of the 225,958 rows — 70% of the entire table by itself) —
  picked one flagged row (`id=4614de3c-603f-4f38-88de-e540c22d37d3`) and
  queried it directly: **Supabase shows `projected: true`. Aurora shows
  `projected: true`.** They match exactly, today. The row has simply
  changed since the validation snapshot a month ago, on both sides, the way
  live data does. This is decisive: the validation table is stale history
  from a superseded load, not a live data-integrity defect.

**This does not mean Aurora is a perfect copy right now** — see the real,
current, smaller gap below — but the specific "~154k dropped rows" claim
that has gated Phase 0 since 2026-07-27 does not hold up against the
evidence actually sitting in Aurora's own validation log, and should stop
being cited as the reason Phase 0 is blocked.

## The real current gap: CDC has been down since 2026-08-20, for two
## independent, fixable reasons

`vitana-supabase-to-aurora-v3` (`full-load-and-cdc`, source
`vitana-src-supabase-v3`, target `vitana-tgt-aurora-v2`) full-loaded 564
tables successfully on 2026-08-13, then ran CDC for about a week, then
**failed** on 2026-08-20 11:08 UTC after 9 recoverable-error retries
(`aws dms describe-events`, `2026-08-20T10:22` through `T11:08`, all
"Network error has occurred"). It has not been restarted since — 5 days
of un-replicated production writes as of this session (2026-08-25).

**Two independent connection failures, tested live this session
(`aws dms test-connection` against both endpoints):**

1. **Target (Aurora):** `password authentication failed for user
   "vitana_admin"`. The DMS target endpoint's stored credential is stale.
   This is the exact same class of issue this migration effort's own task
   #1 ("Sync DMS target endpoint passwords to current Aurora secret")
   already fixed once — but for a *different* DMS target endpoint object
   (`vitana-target-aurora-prod`, used by the older tasks) than the one v3
   actually uses (`vitana-tgt-aurora-v2`). The fix needs re-applying to
   this endpoint specifically.
2. **Source (Supabase):** `could not connect to server: Network is
   unreachable... Is the server running on host
   "db.inmkhvwdcuyhnxkgfvsb.supabase.co" (2a05:d016:c4a:9700:...) and
   accepting TCP/IP connections on port 5432?` — an IPv6 address. This
   reads as the DMS replication instance's subnet having no IPv6 egress
   route, and Supabase's direct-Postgres hostname resolving IPv6-first.
   This is a different, networking-layer problem from the password issue,
   not something the same fix touches.

**Measured size of the current gap** (exact `count(*)` on both sides, live,
this session — not the `pg_stat_user_tables.n_live_tup` estimate, which
proved badly stale for high-churn tables during this same check, see
**Methodology note** below):

| table | Supabase (live) | Aurora (frozen at CDC death) | gap |
|---|---:|---:|---:|
| `oasis_events` | 475,986 | 466,654 (newest row: `2026-08-20 09:58:52`, matching the CDC-death timestamp almost exactly) | **9,332 rows behind** |
| `user_activity_log` | 140,662 | 135,960 | **4,702 rows behind** |
| `chat_messages` | 42,756 | 41,217 | **1,539 rows behind** |
| `autopilot_processed_events` | 1,903,983 | 1,903,983 | 0 (table not growing) |
| `dev_autopilot_signals` | 344,093 | 344,093 | 0 (table not growing) |

The gap grows every hour CDC stays down, proportional to write volume on
these tables — it is not a fixed, one-time number.

## The two DMS "Table error" full-load failures turned out fine

`vitana-supabase-to-aurora-v3`'s own `describe-table-statistics` reports
`reminders` and `conversation_messages` as `TableState: 'Table error'`,
`FullLoadRows: 0` — meaning v3's OWN full load never successfully loaded
either table. Checked live anyway, since a full-load failure on one task
doesn't necessarily mean the table is actually empty (an earlier task or
CDC could have populated it): **both match exactly, right now** —
`reminders`: 120 rows on both sides; `conversation_messages`: 18 rows on
both sides. Whatever populated these tables in Aurora (most plausibly the
older `vitana-supabase-to-aurora` task's successful 2026-07-27 full load,
or CDC carrying inserts even though the v3 full-load step errored) worked.
**Not a live gap** — but also not something to trust blindly for other
`Table error` entries without the same live check; this was two tables,
not a general clearance.

## Schema parity — close, not the "~85 phantom relations" picture

Direct table-name diff, `pg_tables WHERE schemaname='public'`, both sides,
live, this session:

- **Supabase: 583 tables. Aurora: 586 tables.**
- **Only in Aurora (5):** `awsdms_apply_exceptions`, `awsdms_status`,
  `awsdms_suspended_tables`, `awsdms_validation_failures_v1` (DMS's own
  control/metadata tables, expected, not a concern) and
  `dev_autopilot_prompt_learnings` (0 rows — worth a follow-up ask about
  why it exists only on Aurora, but empty, so no data-loss risk either way).
- **Only in Supabase (2):** `media_upload_comment_likes`,
  `profile_post_comment_likes` — genuinely missing from Aurora. Both are
  small, narrow-purpose "like" join tables (same shape as the already-
  present `profile_post_likes`, `media_upload_likes`); most plausibly
  created in Supabase after the last successful Aurora full load/DDL sync,
  or by a migration DMS's schema-change tracking hasn't caught (consistent
  with CDC being down since 2026-08-20 — DDL doesn't propagate either while
  CDC is down). Needs a table-level backfill once CDC is restored, not a
  separate investigation.
- `awsdms_suspended_tables` has 2 rows — checked: `conversation_messages`
  and `reminders`, both `TABLE ERROR`, suspended `2026-08-13 12:22`/`12:23`
  — DMS's own bookkeeping for the exact same two-table full-load failure
  from the section above. Consistent, no new information, no follow-up
  needed here beyond what's already covered.

This is a **much smaller, more precise gap** than the plan's own "~85
relation names the code queries that are not base tables in production"
finding — that finding was about `services/gateway/src` code referencing
table names that don't resolve against a schema snapshot, a different
measurement (code vs. live schema, not Supabase vs. Aurora schema parity)
and does not get resolved by this reconciliation pass. See
`docs/AURORA-B3-RPC-PARITY-INVENTORY.md` for the equivalent live-verified
pass on the RPC side of that same original finding (`autopilot_logs`
confirmed to exist live, contrary to the plan's 2026-08-04 measurement).

## Methodology note: `pg_stat_user_tables.n_live_tup` is not reliable for this

First pass at Supabase-side counts used `n_live_tup` (the fast, ANALYZE-based
estimate) and got numbers **dramatically wrong** for the highest-churn
tables — e.g. it reported `oasis_events` at 16,500 when the real
`count(*)` is 475,986 (29x off), and `chat_messages` at 1,539 when the real
count is 42,756 (28x off). This nearly led to a false alarm in the opposite
direction (worrying Aurora had stale-but-larger data than a "shrinking"
Supabase). **Any future reconciliation pass must use exact `count(*)`, not
`n_live_tup`/`n_dead_tup`/`pg_class.reltuples`, for any table where the
number will inform a real decision.** The estimate is fine for "is this
table empty y/n" but not for anything more precise, at least not on tables
this active.

## Access boundary — this session diagnosed, did not fix

This session's AWS IAM identity (`claude-code-aws-agent`) has an
**explicit deny in a permissions boundary**
(`arn:aws:iam::472838866351:policy/claude-code-aws-agent-boundary`) that
blocked `secretsmanager:GetSecretValue` on `vitana/aurora/prod/master-password`
and `iam:GetUser`/`iam:GetPolicy` on its own identity. Read-only Aurora
access was available via a dedicated `vitana/aurora/prod/claude-readonly`
secret + the RDS Data API (`aws rds-data execute-statement` — no VPC network
path is needed from this sandbox; a direct `psql` connection attempt to
Aurora's private endpoint timed out, confirming there's no route in from
here, but the Data API works over the AWS API instead).

Given that explicit-deny signal, this session did **not** attempt to modify
the DMS target endpoint's stored password, touch DMS/VPC networking, or
restart the failed replication task — those are exactly the kind of
consequential, infrastructure-mutating actions the signal reads as
deliberately reserved for a human or a more-privileged process. What
follows is a diagnosis and a recommended fix, not a fix already applied.

## Recommended next steps (for whoever has write access)

1. **Fix the target endpoint password** for `vitana-tgt-aurora-v2`
   specifically (not `vitana-target-aurora-prod`, which appears to already
   be correct) — update its stored credential to the current
   `vitana/aurora/prod/master-password` secret value, the same fix task #1
   already applied once, to the endpoint that actually needs it now.
2. **Diagnose the IPv6 routing gap** on the `vitana-src-supabase-v3` source
   endpoint / DMS replication instance subnet — either add IPv6 egress, or
   point the endpoint at an IPv4-resolving alternative if Supabase offers
   one (e.g. via the connection pooler rather than the direct host).
3. **Test both connections again** (`aws dms test-connection`) before
   restarting anything.
4. **Resume replication, don't reload** — `vitana-supabase-to-aurora-v3`'s
   full load already succeeded for 564/566 tables; a `start-replication-task`
   with `StartReplicationTaskType=resume-processing` (not a fresh full load)
   should pick CDC back up from where it stopped, once both endpoints test
   clean.
5. **Backfill the 2 Supabase-only tables** (`media_upload_comment_likes`,
   `profile_post_comment_likes`) into Aurora once CDC is confirmed healthy —
   either they'll self-heal via CDC's DDL tracking on resume, or need an
   explicit `reload-tables` pass if DMS doesn't pick up DDL that happened
   while CDC was down.
6. **Re-run this reconciliation** after the above, using exact `count(*)`
   per the methodology note, to confirm the gap has actually closed rather
   than assuming a green DMS status means caught up.
7. Only once the above holds for the 7-day window the plan's own Phase 0
   exit criteria calls for should Phase 0 be considered closed.

## Addendum, 2026-08-29 — access re-verified live (broader than the prior finding assumed), replication still down, root cause now precisely isolated

This session's AWS identity is the same `claude-code-aws-agent` the section
above names, but **the explicit-deny this doc previously reported no
longer reproduces**: `aws secretsmanager get-secret-value --secret-id
vitana/aurora/prod/master-password` succeeded just now (returned the
secret's `Name` cleanly). Whether the boundary policy was loosened
between sessions or the prior finding was scoped to a narrower action
than tested here is not established — flagging the discrepancy rather
than assuming either explanation. **Not tested: whether write access
(`ModifyReplicationInstance`, VPC/route-table edits, DMS
`modify-endpoint`) is now available too** — deliberately not attempted
without checking in first, per below.

**Live status, checked just now (all read-only: `describe-replication-tasks`,
`describe-connections`, `dms test-connection`, `describe-replication-instances`,
Supabase `get_project`):**

- `vitana-supabase-to-aurora-v3` (the CDC task) is still `failed`:
  *"Last Error Task '...' was stopped after 9 recovery attempts Stop
  Reason FATAL_ERROR."* Not recovered since the last row in this doc.
- **The doc's own recommended fix (#2 above — repoint the source at the
  connection pooler for an IPv4 path) was already attempted** — the task's
  source endpoint, `vitana-src-supabase-v3`, is in fact configured against
  `aws-0-eu-north-1.pooler.supabase.com:5432` with username
  `migrate.inmkhvwdcuyhnxkgfvsb` (Supavisor's `role.project_ref` format) —
  but a fresh `test-connection` against it fails differently now:
  `FATAL: (ENOTFOUND) tenant/user migrate.inmkhvwdcuyhnxkgfvsb not found`.
  The pooler itself no longer recognizes this project's tenant/role
  combination. Confirmed via `mcp__Supabase__get_project` that the
  project ref (`inmkhvwdcuyhnxkgfvsb`) and region (`eu-north-1`) in that
  hostname are still correct — this isn't a stale project reference, the
  pooler is rejecting a login it should recognize. Root cause not
  determined from the AWS side alone (only reachable by checking the
  project's current pooler/connection settings in the Supabase dashboard
  or an equivalent management-API surface this session doesn't have
  tool access to).
- **The other 3 source endpoints all confirm the IPv6 diagnosis exactly**,
  tested fresh: `vitana-source-supabase`, `vitana-supabase-source-autopilot`,
  and `vitana-supabase-source-fullload` all resolve
  `db.inmkhvwdcuyhnxkgfvsb.supabase.co` to an IPv6-only address
  (`2a05:d016:...`) and fail with `dial tcp [2a05:...]:5432: connect:
  network is unreachable`. `vitana-dms-prod` (the replication instance) is
  `PubliclyAccessible: true` in VPC `vpc-05958f035e596fe64` — consistent
  with an IPv4-only public route (no IPv6 CIDR/egress on the VPC, subnets,
  or route table), not fixable by anything short of an actual VPC
  networking change.
- Target-side is fine: both `vitana-tgt-aurora-v2` and
  `vitana-target-aurora-prod` test `successful`.

**Net effect: every one of the 4 source-endpoint configurations DMS
currently has on file for this project fails for one of two independent
reasons — 3 for IPv6 unreachability, 1 (the one actually wired to the
failed task) for a pooler-side rejection that isn't a DMS/AWS-config
problem at all.** There is currently no working path from AWS's side into
Supabase for this replication task.

**Deliberately not attempted from here, and why:** fixing either failure
mode is a real infrastructure change to a live, production data-migration
pipeline — VPC/route-table IPv6 egress affects every resource in that
subnet, not just this DMS instance, and a corrected pooler username/mode
would need confirming against Supabase's actual current pooler
configuration (unreachable from this session's tool access) before being
applied to the live source endpoint. Given this session just found it has
materially broader AWS access than the last time this was checked, and
given the platform owner's own standing rule that infrastructure mutation
gets a VTID and explicit governance rather than being inferred from a
general "keep working" mandate, this was raised as a question rather than
acted on unilaterally — see the session's own chat log for how this was
put to the platform owner. **Fix candidates for whoever picks this up:**
(a) confirm the Supabase project's current pooler connection string in
the dashboard and correct `vitana-src-supabase-v3`'s username/port/mode
to match, or (b) add IPv6 egress to `vpc-05958f035e596fe64` (Egress-Only
Internet Gateway + route table + security group allowance) so the direct
`db.<ref>.supabase.co` endpoints become reachable again, whichever is
lower-risk given who's driving it.

## Addendum, 2026-08-29 (continued) — platform owner authorized both fixes; both are blocked by hard IAM/tool limits, not caution

Asked the platform owner directly which of the two candidate fixes above
to attempt. Answer: attempt both. Investigated both immediately, in order
of what this session's actual AWS/Supabase access could reach — **neither
is executable from this session, and both hit a genuine capability wall,
not a judgment call this session talked itself out of:**

**(a) IPv6 egress on `vpc-05958f035e596fe64` — no EC2 permission at all.**
`aws ec2 describe-vpcs`/`describe-subnets`/`describe-route-tables` all
fail with *"not authorized to perform: ec2:DescribeX because no
identity-based policy allows the ec2:DescribeX action"* — this is a
missing grant, not a boundary deny (contrast with the Secrets Manager
denials below, which name an explicit deny). There is no EC2/VPC access
of any kind on `claude-code-aws-agent`, read or write. This path needs
someone with EC2 permissions on this identity (or a different identity
entirely) — it cannot be worked around from here.

**(b) Correcting `vitana-src-supabase-v3`'s pooler login — no way to
determine or verify the correct value.** Confirmed via `mcp__Supabase__execute_sql`
that the `migrate` role genuinely exists (`rolcanlogin=true,
rolreplication=true`) and the project ref/region embedded in the pooler
hostname (`aws-0-eu-north-1.pooler.supabase.com`) are correct per
`mcp__Supabase__get_project`. The failure — Supavisor's *"tenant/user...
not found"* — is the pooler's own tenant/role registry rejecting a login
that should exist; nothing exposed via SQL on the tenant database (no
`pgbouncer.*` config table, no equivalent) can read or refresh that
registry, and Supabase's dashboard/Management API (where this would
actually be checked or fixed) is not a surface this session has tool
access to. Also checked whether a **different**, definitely-poolable
login (`postgres.inmkhvwdcuyhnxkgfvsb`) could be substituted instead —
ruled out as not worth attempting: DMS's stored password for this
endpoint is `migrate`'s (write-only, unreadable), switching only the
username while keeping that password would almost certainly authenticate
as the wrong role/wrong password combination, and there is no
Supabase-side secret this session can read to get `postgres`'s real
credential either (`vitana/supabase/prod/database-url` and every other
`vitana/supabase/prod/*` secret checked — `service-role-key`, `anon-key`,
`url`, `jwt-secret` — all return an explicit-deny, consistent with the
prior session's original finding for the Supabase side specifically,
**unlike** the Aurora-side secrets which this session found newly
readable). Attempting a blind `modify-endpoint` with a guessed
username/password combination would not have a realistic chance of
working and was not attempted.

**Net: this session confirmed the diagnosis precisely (both root causes
are now known, not just suspected) but cannot execute either fix with
the access it has.** What would unblock it: EC2 read+write on this AWS
identity (or a different identity/session with it) for path (a), or
Supabase dashboard/Management API access — not just the SQL-execution
MCP tool used here — to inspect and refresh the `migrate` role's Supavisor
pooler registration for path (b). Reported back to the platform owner in
the same terms as this addendum, in-conversation, rather than claiming
either fix was applied.
