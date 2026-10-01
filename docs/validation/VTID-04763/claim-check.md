# VTID-04763 — daily reminder claim, verified before it touches the shared database

`claim_due_audiobook_reminders` (migration `20261001130000`) was executed
against an in-memory Postgres (PGlite) with eight members covering every
case. Run it yourself:

```bash
mkdir /tmp/pg && cd /tmp/pg && npm i @electric-sql/pglite
cp <repo>/docs/validation/VTID-04763/pglite-claim-check.mjs claim.mjs
node claim.mjs <repo>/supabase/migrations/20261001130000_VTID_04763_audiobook_daily_reminder_claim.sql
```

Result (2026-10-01):

```
ok   due members claimed: 1,8 (expected 1,8)
ok   primary tenant returned
ok   claim stamps today and keeps the preference
ok   a second call the same day claims nobody
ok   unknown time zone skipped, not failed
ALL CLAIM CHECKS PASSED
```

Cases: due now (claimed); not yet due; 2-hour window passed; already sent
today; already listened today; unknown time zone; no reminder; sent on an
earlier day (claimed). The first run of this check caught a real defect:
Postgres evaluated `AT TIME ZONE` for the invalid zone before the WHERE
filter, which would have failed the whole batch in production. The
conversions are now guarded by CASE.
