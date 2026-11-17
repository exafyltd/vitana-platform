# VTID-05803 acceptance — status: NOT ACCEPTED

The Aurora staging cutover is not complete. Each criterion below carries its real state and the evidence it rests on.
A criterion marked FAIL or NOT RUN is not satisfied and must not be read as passed.

AC-1 Proxy runs the staging revision and is healthy. State: PASS.
Revision `vitana-postgrest-aurora-staging:19` is the only PRIMARY deployment, one task running, proxy container HEALTHY.
TEST: commands.log entries 1–2 (ECS describe-services and wait services-stable).

AC-2 PostgREST connects to Aurora staging. State: PASS.
PostgREST 12.2.3 reports a successful connection to PostgreSQL 17.9 and loads 0 relations.
TEST: commands.log entry 3 (CloudWatch /ecs/vitana-postgrest-aurora-staging).

AC-3 Authenticated read reaches the staging writer. State: PASS.
Database `vitana`, user `authenticator`, server 10.0.10.108. The interface sits in subnet-0ff45a2051c5e5482, which belongs to vitana-aurora-staging-subnets.
TEST: outputs/identity-probe-authenticator.out and commands.log entry 9.

AC-4 Staging schema is restored from source. State: FAIL.
The `public` schema has 0 relations. The `authenticator` role cannot create objects.
TEST: outputs/privilege-probe-authenticator.out (authenticator|f|f|f|f|f|public).

AC-5 Data is loaded and reconciled against source. State: NOT RUN.
Blocked by AC-4. No row counts have been compared.
TEST: not run; there is no reconciliation output to cite.

AC-6 Functions, triggers, sequences, grants, RLS and the outbox are applied. State: NOT RUN.
Blocked by AC-4.
TEST: not run; there is no output to cite.

AC-7 Authenticated read/write and two-user RLS tests pass. State: NOT RUN.
Blocked by AC-4 and AC-6.
TEST: not run; there is no output to cite.

AC-8 The gateway reconnects to staging. State: NOT RUN.
The preview gateway is stopped at desired 0 and cannot be started from this identity (ecs:UpdateService denied).
TEST: commands.log entry 12 (preview /alive returns 503, build-info returns 504).

Single blocker: a DDL-capable staging credential. Candidate: the RDS-managed master secret for vitana-aurora-staging.
The staging `database-url` secret resolves to a legacy instance, vitana-postgres-staging, in status inaccessible-encryption-credentials.
TEST: outputs/staging-database-url-probe.out.
