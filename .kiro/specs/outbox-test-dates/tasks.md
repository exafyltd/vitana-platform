# Tasks — outbox-test-dates
<!-- lane: relative-dates -->
## relative-dates
- [ ] D1. Record red on origin/main (2/17), then replace the three outbox `created_at` fixtures with `OUTBOX_T0`/`OUTBOX_T1`.
- [ ] D2. `docs/validation/<VTID>/staging-tests.json` + `commands.log`.
Acceptance: the file passes 17/17, full `npx vitest run` is green, only the lane paths change, no assertion is loosened.
<!-- lane: relative-dates -->
