# VTID-04762 — Prolog migration, verified before it touches the shared database

Staging and production share one Supabase project, so this migration is
applied once, at the production step, through `RUN-MIGRATION.yml`. Before
that, it was run end to end against an in-memory Postgres (PGlite) whose
tables mirror the live columns and constraints (read from the live catalog,
read-only, 2026-10-01): 94 sessions / 254 topics, a current published
snapshot, an older snapshot, and three members at sessions 1, 5 and 94.

Run it yourself:

```bash
mkdir /tmp/pg && cd /tmp/pg && npm i @electric-sql/pglite
cp <repo>/docs/validation/VTID-04762/pglite-migration-check.mjs run.mjs
node run.mjs <repo>/supabase/migrations/20261001120000_VTID_04762_audiobook_season0_prolog.sql
```

Result (2026-10-01):

```
ok   six topics added
ok   sessions now end at 100
ok   Prolog T255-T260 are sessions 1-6, T251 moved to 7
ok   Prolog topics carry chapter prolog
ok   T001 moved 5 -> 11
ok   members: 1 stays 1 (gets the Prolog), 5 -> 11, 94 -> 100
ok   current snapshot counts updated
ok   snapshot has every topic
ok   snapshot starts with the Prolog
ok   snapshot carries the German narration
ok   snapshot sessions match the draft table exactly
ok   non-current versions untouched
ok   English rows with narration for all six
ok   T255..T260 narration fits one Polly chunk (759-828 chars)
ok   German narration is du-form
ok   re-run adds nothing
ok   re-run shifts nothing
ok   re-run leaves members alone
ok   re-run leaves the snapshot alone
ALL MIGRATION CHECKS PASSED
```

After applying in production: dispatch `I18N-DB-SEED.yml` so the other
locales (es, sr, fr, pt, ru, pl, zh, ar, tr) get the six episodes the same
day instead of at the nightly run.
