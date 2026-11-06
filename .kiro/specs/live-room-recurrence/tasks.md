# Tasks — live-room-recurrence

Code starts only after each lane has its CI-allocated VTID and its `depends_on` lanes are `done`.

<!-- lane: db-live-series -->
- [ ] T1 SQL test first (`scripts/ci/sql-tests/run-live-room-series-test.sh`, `SQL-LIVE-ROOM-SERIES.yml`); record red on base.
- [ ] T2 Migration `supabase/migrations/20261106120000_live_room_series.sql` (table, columns, unique index, RLS, rrule CHECK).
- [ ] T3 `DATABASE_SCHEMA.md` changelog row.
- [ ] T4 `docs/validation/<VTID>/commands.log`, `staging-tests.json` with one `/alive` probe, "migration not applied: not verified on staging".

Acceptance: Outcome: a series can be stored with a valid rule and tenant isolation holds. States: null `series_id` on
every existing session; invalid rule refused. Contract: no change to existing functions. Diff only inside `paths`.

<!-- lane: gateway-live-series -->
- [ ] T1 Tests first (`services/gateway/test/live-room-series*.test.ts`), red on base.
- [ ] T2 `services/gateway/src/services/live-series.ts`: expansion, validation (52 cap, 12 months), materialisation, series edit, cancel.
- [ ] T3 `routes/live.ts`: `recurrence` on create; `scope` and `recurrence` on PATCH; `POST .../sessions/series/cancel`; hourly tick.
- [ ] T4 `npx jest` on the new and existing live suites, `npm run typecheck`, `npm run build`; `commands.log`.
- [ ] T5 `staging-tests.json`: `/alive` and `PATCH .../sessions/current` without a token (401). Read-only.

Acceptance: Outcome: a creator creates a weekly or monthly room and every occurrence appears in Live Rooms and the
calendar; "this and all following" changes only scheduled future occurrences. States: retry creates no duplicates;
live/ended occurrences untouched; co-host of a series follows the rule; paid access refused. Contract: request/reply
shapes and status codes with `file:line`. Diff only inside `paths`.

<!-- lane: v1-live-series -->
- [ ] T1 Tests first: Repeat control options in both modes, payload carries `recurrence`, scope prompt only for a series, label on card; red on base.
- [ ] T2 Repeat control in `SessionFormFields.tsx`; `EditSessionDialog.tsx` scope prompt; `liveRoomService.ts` types.
- [ ] T3 i18n (de first, du-form; then en and the other shards); `npm run i18n:inventory`; `docs/SCREEN_INVENTORY.md`.
- [ ] T4 `npm test`, `npm run lint`, `npm run build`.
- [ ] T5 Playwright screenshots 1400×900, 390×844 and ar of the Repeat control open; view them.
- [ ] T6 Read-only staging spec opening the Repeat control and asserting its options; `staging-tests.json`.

Acceptance: Outcome: Go Live and Edit both offer Repeat with the same options; the scope prompt appears for a series.
Accessibility: combobox rules as the co-host picker, logical properties only (RTL). Diff only inside `paths`.
