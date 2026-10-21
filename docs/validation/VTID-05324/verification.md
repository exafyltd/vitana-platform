# VTID-05324 — mt-launch/pack-intake-db verification

Session `kiro-hotmail-202610211408-c407`, base `origin/main` @ `903b928281af3bac945bb6564bb899a1613d5abc`.
No live system was read or written; nothing here was applied to any database.

## Renumber check (tasks.md P5)
Latest migration on `origin/main` at build time: `20261021140000_vtid_05310_chat_send_reliability.sql`, earlier
than `20261101110000`, so the plan's numbers stand. The Jest suite fails if another file takes either version.

## Red on base → green on head
| Command (cwd `services/gateway`) | Base (`origin/main` + only the new test file) | Head |
|---|---|---|
| `npx jest test/mt-launch-pack-intake-pgtap.test.ts` | exit 1 — `Tests: 15 failed, 2 passed, 17 total`: assertion failures (`Expected: true / Received: false`, empty migration source) because the migration files, queue rows, baseline entries and rollback are absent; no module-resolution error | exit 0 — `Tests: 17 passed, 17 total` |

Base run re-recorded (review round 1) on clean `origin/main` @ `84fc0ca6a0d116f4e41dfd77c5125cb329b95f15` with only
the test file added (every other lane change reverted for the run; `git diff --stat` vs base shows one file). The two
tests that pass on base are negative guards that hold with no migration present: "never writes to WS5
tenant_content_overrides" and "the health-table guard catches a planted read (self-test)". The first base run
(`mtl-base-pid` without its own `node_modules`) failed on a `setup-tests.ts` module-resolution error and is superseded.
Head re-run after merging the same `origin/main`.

## Other checks on head
| Command | Result |
|---|---|
| `npx tsc --noEmit` (services/gateway) | exit 0, no output |
| `node --test scripts/ci/check-migration-drift.test.cjs` (repo root) | exit 0 — 8 pass, 0 fail |

## Database dry-run
Not executed: neither the pgTAP plan nor a local migration dry-run was run, because no Postgres is available in this
session (no docker/psql). They are covered by the RUN-MIGRATION pre/post checks at apply time. The behavioural pgTAP plan is
`pgtap-pack-intake.sql` (throwaway database only); the read-only `pre-check.sql` / `post-check.sql` run with the
RUN-MIGRATION apply. The Jest suite pins the same properties from the migration source in CI.

## Decisions taken
- `item_key` values are snake_case (`anchor_person_consent`, not `anchor-person-consent`) to match the other twelve keys.
- `tenant_id` references the live key `tenants(tenant_id)` with `ON DELETE CASCADE` (precedent VTID-04716);
  the intake migration refuses to run if that column is missing.
- Client roles lose every table privilege (`REVOKE ALL … FROM PUBLIC, anon, authenticated`) on top of the
  service-role RLS policy, so a non-service-role read fails (42501) instead of returning an empty set.
- `get_tenant_launch_readiness` returns `NULL` for an unknown tenant; items without a row count as `not_started`.
