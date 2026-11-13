# VTID-05023 M4: welcome-chat skip test and loud-failure warning

Branch: `cutover/vtid-05023-M4-welcome-skip-test`, cut from `cutover/vtid-05623-welcome-trigger` (MR !28 source, commit 68c8e355fb).
The welcome migration is unchanged. No new migration was needed: the handler already raises a WARNING, and the skip already marks the user sent.

## Account and data rules (HARD RULE 31)

- This run used only synthetic UUIDs of the form `11111111-1111-4111-8111-1111111111xx`. No other user ID was written.
- The earlier scratch run (reported in the M3 review) used the account `a27552a3-0257-4305-8ed0-351a80fd3701`. That run was a write as that account, which rule 31 forbids. It is recorded here as a violation.
- This run did not use `a27552a3`. The string does not appear in any file this step added or changed.
- No production, AWS, or remote database was touched. Nothing was merged. VTID-05005 was not touched.

## Harness

- Local PGlite (PostgreSQL 18 wasm) at `/projects/sandbox/.tools/pglite`, the same package the repo harness uses (`docs/validation/VTID-05507/pglite-harness/run.mjs` with its `shim.sql` pgTAP shim).
- In-memory database per run. Not a real Postgres and not the full production schema. Stand-in tables cover only the columns the function reads (see `supabase/tests/vtid_05623_welcome_skip_fixture.sql`).
- CI's `supabase test db` was not run from this sandbox.

## Files added

- `supabase/tests/vtid_05623_welcome_skip_fixture.sql`: stand-in tables and the welcome trigger, as VTID-03089 defines it.
- `supabase/tests/vtid_05623_welcome_skip.test.sql`: skip test, 7 assertions, synthetic UUIDs.
- `supabase/tests/vtid_05623_welcome_warning.test.mjs`: loud-failure test, 3 assertions. It uses PGlite's notice callback, because SQL cannot observe a `RAISE WARNING`.

## 1. Skip test, passing (migration with skip in place)

Command:
```
node docs/validation/VTID-05507/pglite-harness/run.mjs \
  --sql supabase/tests/vtid_05623_welcome_skip_fixture.sql \
  --sql supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql \
  supabase/tests/vtid_05623_welcome_skip.test.sql
```
Output:
```
# loaded supabase/tests/vtid_05623_welcome_skip_fixture.sql
# loaded supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql
1..7
ok 1 - service account: 0 welcome messages sent or received
ok 2 - service account: 0 group enrolments
ok 3 - service account: marked welcome_chat_sent so a retry cannot re-fire
ok 4 - test actor: 0 welcome messages sent or received
ok 5 - test actor: 0 group enrolments
ok 6 - normal member: welcome messages sent
ok 7 - normal member: enrolled in the system group
```
Exit code 0.

## 2. Mutation check, skip removed (scratch copy in /tmp, not in the repo)

The skip `IF EXISTS (service_bot_accounts) OR EXISTS (notification_test_actors) ... END IF;` block was deleted from a copy of the migration (412 bytes removed). The same test was run against that copy.

Command:
```
node docs/validation/VTID-05507/pglite-harness/run.mjs \
  --sql supabase/tests/vtid_05623_welcome_skip_fixture.sql \
  --sql /tmp/vtid05023-M4-mutant/mutant_no_skip.sql \
  supabase/tests/vtid_05623_welcome_skip.test.sql
```
Output:
```
# loaded supabase/tests/vtid_05623_welcome_skip_fixture.sql
# loaded /tmp/vtid05023-M4-mutant/mutant_no_skip.sql
1..7
not ok 1 - service account: 0 welcome messages sent or received
not ok 2 - service account: 0 group enrolments
ok 3 - service account: marked welcome_chat_sent so a retry cannot re-fire
not ok 4 - test actor: 0 welcome messages sent or received
not ok 5 - test actor: 0 group enrolments
ok 6 - normal member: welcome messages sent
ok 7 - normal member: enrolled in the system group
```
Exit code 1. Tests 1, 2, 4 and 5 fail, so the skip test catches the removed skip. Test 3 still passes in the mutant because the normal fan-out path also sets the flag.

## 3. Restore and re-run, passing

The repo migration was never edited. The mutation ran only on the `/tmp` copy. The passing run in section 1 is the restored state. Its output is the same as section 1.

## 4. Loud-failure test

Command: `node supabase/tests/vtid_05623_welcome_warning.test.mjs`. It drops `notification_test_actors`, inserts a synthetic primary member, and records notices.

Output (passing):
```
1..3
ok 1 - user_tenants insert succeeds when allowlist table is missing
ok 2 - trigger raises a WARNING naming the failed user
ok 3 - WARNING carries the SQL error (notification_test_actors does not exist)
```
Exit code 0.

Mutation check: `RAISE WARNING` changed to `RAISE NOTICE` in a scratch copy under `/tmp`.
Output:
```
1..3
ok 1 - user_tenants insert succeeds when allowlist table is missing
not ok 2 - trigger raises a WARNING naming the failed user
not ok 3 - WARNING carries the SQL error (notification_test_actors does not exist)
# insertError: none
# warnings: []
```
Exit code 1.

## Findings for the owner (not changed here)

- **Recipients are not filtered.** The welcome fan-out for a later normal member counts and writes every tenant member except self and the Vitana bot. Service and test accounts stay in that list, so they can receive a welcome message from a new member. The skip only stops a service or test account from sending or enrolling. Excluding allowlisted accounts from the recipient query is a behaviour change, so it is left for the owner to decide.
- **A missing allowlist table skips every welcome.** When `notification_test_actors` is absent, the lookup raises an error for every new member. The handler then logs a WARNING and skips that member's welcome. This is the designed behaviour (silent skip, loud log). Check the warning in logs after deploy.
- The new `.mjs` test is not wired into CI. `supabase test db` runs only `.test.sql` files, so the warning test needs a CI step if the owner wants it run automatically.

## 5. Blocked: rehearsal-clone run and read-only check of a27552a3

Both need the rehearsal clone or the owner's database access, which this sandbox cannot reach. Status: **blocked**.

The owner can run this read-only query on the rehearsal clone:

```sql
SELECT account_id FROM notification_test_actors WHERE account_id = 'a27552a3-0257-4305-8ed0-351a80fd3701';
```

Note: the repo's skip uses `notification_test_actors.user_id`, but the query above uses `account_id`. The owner should confirm the real column name first. If the column is `user_id`, use `SELECT user_id FROM notification_test_actors WHERE user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701';`.

Rehearsal-clone run of the skip test: blocked for the same reason. The owner can run the same `run.mjs`-style checks against the clone once the migration is applied there.
