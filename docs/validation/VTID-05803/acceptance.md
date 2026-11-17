# VTID-05803 acceptance — status: NOT ACCEPTED

The Aurora staging cutover is not complete. This file records the criteria and their current state, with evidence.

| Criterion | State | Evidence |
|---|---|---|
| Proxy runs the staging revision, healthy | PASS | commands.log 1–2 (revision 19, HEALTHY) |
| PostgREST connects to Aurora staging | PASS | commands.log 3 (PostgreSQL 17.9) |
| Authenticated read against staging, staging host | PASS | outputs/identity-probe-authenticator.out, commands.log 9 |
| Staging schema restored from source | FAIL | 0 public relations; no DDL-capable staging credential |
| Data loaded and reconciled | NOT RUN | blocked on the restore |
| Functions, triggers, sequences, grants, RLS, outbox | NOT RUN | blocked on the restore |
| Authenticated read/write and two-user RLS tests | NOT RUN | blocked on the restore |
| Gateway staging reconnection | NOT RUN | preview gateway stopped; ecs:UpdateService denied to this identity |

Single blocker: a DDL-capable staging credential provisioned through Secrets Manager. `vitana/aurora/staging/database-url`
resolves to a legacy instance (vitana-postgres-staging, inaccessible-encryption-credentials). The authenticator role is
read-only (outputs/privilege-probe-authenticator.out).
