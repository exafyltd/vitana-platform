# pgTAP was not run for VTID-05464

pgTAP was not run on this host. The host has no PostgreSQL server or client tools (`psql`, `pg_ctl`, `initdb`,
`pg_prove` and `postgres` are not on PATH), and the Docker CLI cannot start a container here (`docker info` fails with
"could not find a working conmon binary"). No database connection was made from this session.

Not verified here:
- `supabase/tests/mt_identity_hook_shadow.test.sql` (pgTAP, `plan(36)`). None of its 36 assertions has run, so no pass
  is claimed for any criterion that cites it in `acceptance.md`.
- The apply, idempotence, rollback and re-apply sequence in `docs/validation/VTID-05464/commands.log`.

Verified without a database (see `static-checks.txt`): the grammar parse of all five SQL files with libpg-query 18.2.2,
the PR-GATE `lintMigration` on the three migrations, the `duplicate-table-name` impact rule, the comment and shadow
checks, and that every test name cited in `acceptance.md` exists in the pgTAP file.

Where the pgTAP run belongs: a throwaway local PostgreSQL 16 cluster with pgTAP installed, never a shared database
(staging and production share one Supabase project). The command order is in `commands.log`. The owner-approved
RUN-MIGRATION.yml dispatch runs `post-check.sql` before and after each apply.
