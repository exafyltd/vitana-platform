# VTID-05803 — acceptance status

| Criterion | Status | Evidence |
|---|---|---|
| Sequence inventory: 25 public = 6 identity + 15 serial + 4 standalone | done (production catalogue, read-only) | prod-catalog-connector header |
| Export script: read-only privilege checks, cleanup trap, checksum, fail-closed | done in rehearsal (role created and removed; trap tested) | outputs/*/results.txt |
| Restore: fail-closed ordering, preservation of 136 FKs, RLS, 8 auth triggers | done in synthetic rehearsal, 23 metrics identical | outputs/20261117T211331Z/ |
| Auth.users scope: without password hashes only | done (approved scope; hash guards tested) | outputs/*/results.txt N3, N6 |
| Staging outbox targets .invalid host; production host excluded | done in rehearsal (genuine trigger probe) | outputs/*/results.txt |
| 26 cron jobs absent from staging | by construction, verified in rehearsal (no pg_cron, no cron schema). Live Aurora check not yet run | outputs/*/results.txt |
| Two-user RLS isolation through auth.uid() | done in rehearsal (users 1 and 2, anonymous denied) | outputs/*/results.txt |
| Native export from production | BLOCKED: native PostgreSQL authentication (SQLSTATE 28P01) | external (Supabase Support) |
| Aurora staging load and reconciliation on the live database | NOT DONE. Requires the production export | depends on the row above |
| Gateway reconnection, acceptance tests, temporary-access cleanup | NOT DONE | — |

Staging migration is NOT complete. The synthetic rehearsal does not count as the migration.
