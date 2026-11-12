# VTID-05558 — Acceptance (live-room-edit-cohost / db-cohost-authz)

Scope of this PR: one migration (host helper, co-host validation, 13 host gates, a guard on browser writes to `co_hosts`),
its throwaway-Postgres test and workflow, and the `DATABASE_SCHEMA.md` row. Applying the migration is an owner decision
(collaboration.md 7d) and is not part of this PR. MERGE_PAYLOAD_PREVIEW: none (a migration file and CI files; no service deploys behaviour from it).

AC-1 — The creator and a listed co-host of the room's tenant are hosts; an unlisted member, a listed member of another tenant, a co-host who left the tenant and a NULL user are not.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 1 (outputs/sql-test.txt: PASS vtid-05558 live room cohost).

AC-2 — The validator keeps only same-tenant members, in order, once, and drops the creator, other tenants, test and service accounts.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 2.

AC-3 — Only the gateway (service_role) can call the helper and the validator; authenticated and anon cannot.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 3.

AC-4 — transition_status, end_session, get_lobby, update_metadata, admit, reject, admit all, kick, ban, set_host_present, join, state and check_access accept the creator and a co-host and refuse a stranger and another tenant's member.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql sections 4 to 9.

AC-5 — A co-host cannot kick or ban the creator or another host; the creator can still remove a co-host.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 6 (TARGET_IS_HOST).

AC-6 — A host leaving does not clear host_present while another host is in the session; the last host leaving does.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 7.

AC-7 — A browser session (authenticated, anon) cannot set or change community_live_streams.co_hosts; the gateway role and the migration owner can.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 10.

AC-8 — The tests fail on the old behaviour and when the migration is sabotaged.
  TEST: outputs/red-on-base.txt (original bodies: "transition_status as cohost ... NOT_HOST") and outputs/mutation-checks.txt (two sabotaged migrations fail on the matching assertion).

AC-9 — Re-applying the migration is safe; the 13 function bodies differ from their previous definitions only in the host comparison, the kick/ban target guard, and the two noted set_host_present changes.
  TEST: scripts/ci/sql-tests/live-room-cohost.sql section 11 and outputs/function-diff.txt.

Not claimed here: behaviour on the deployed database. That needs the owner to approve and apply the migration; it is reported as not verified on staging.
