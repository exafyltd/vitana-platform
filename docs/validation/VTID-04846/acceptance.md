# VTID-04846 — the registry answers every navigation case (retire-legacy step 2, part 1)

## Problem (inventory, read-only)

`NAV_V2_ENABLED=true` on both gateways, yet the legacy navigator
(`navigation-catalog.ts`, the `nav_catalog` DB scorer, `navigator-consult.ts`)
still ran in five cases:

1. `get_current_screen` had no registry branch at all, so "where am I" and
   the system instruction's screen hint (`describeRoute`) always read the old
   catalog. Pages it never had (`/earthlinks`, `/my-tickets`, `/shop`,
   `/sharing/campaigns/:id`, …) were "Unknown screen".
2. Screens about one item (a member profile, a group, a match, one
   conversation) fell through to the legacy handler.
3. The three disabled panels (`OVERLAY.EVENT_DRAWER`, `MEETUP_DRAWER`,
   `PROFILE_PREVIEW`) bypassed the registry's `disabled` gate that way and were
   dispatched to a client with no listener for them.
4. `/admin`, `/backoffice`, `/staff`, … fell through to the legacy navigator,
   which refused every screen on `/admin` and treated the rest as the member
   app.
5. A resolver outage (Titan unavailable) fell back to the old keyword scorer.

The My Journey Audiobook/full-app switch (NAV_GUIDED_JOURNEY) only existed on
the legacy path, so it had silently stopped working when NAV_V2 went live.

## Change

With `NAV_V2_ENABLED=true` nothing reaches the legacy navigator any more
(the flag-off path is unchanged; deleting it is the next step):

- `openScreen` opens entity screens: the route is filled from the id a prior
  tool result handed the model. The tool schema's older argument names still
  work (`groupId`, `match_id`, `vitana_id`). There is no id → `missing_param`,
  never a guess. The access, viewport, surface, `disabled` and
  already-there gates are the same as for every other screen.
- `findScreenForRoute` (nav-registry) names any page, entity pages and
  unknown sub-pages included. `get_current_screen` and `describeRoute` use it.
- `/admin` refuses voice navigation up front; the other role areas use the
  member app's screens, as the legacy navigator did.
- Resolver outage: a request that is exactly one screen's name still opens
  it; anything else gets an honest "screen lookup unavailable", never a guess.
- NAV-ENTITY-RESOLVE (profile by name) and NAV-GUIDED-JOURNEY run on the
  registry path, as shared helpers.

## Acceptance criteria

AC-1: entity screens open with the id from a prior tool result, under the
  registry param name and the older tool-schema names; without the id the
  result is `missing_param` and nothing is dispatched.
TEST: npx jest test/navigation/vtid-04846-registry-only.test.ts
AC-2: disabled panels stay closed even with an id; member-only entity
  screens stay closed to anonymous visitors; "already there" is detected on
  the same item.
TEST: npx jest test/navigation/vtid-04846-registry-only.test.ts
AC-3: `get_current_screen` and the system-instruction screen hint name the
  page from the registry in the member's language (entity pages, section pages
  and unknown sub-pages included); an undescribed page is "Unknown screen".
  Over every catalog and registry route, the registry names 76 pages the old
  catalog did not. The 6 the catalog alone named are `<Navigate>` redirects,
  which the app never reports as the current page.
TEST: npx jest test/navigation/vtid-04846-registry-only.test.ts
AC-4: `/admin` refuses voice navigation; `/backoffice` and the other role
  areas open member-app screens.
TEST: npx jest test/navigation/nav-dispatch.test.ts
AC-5: with the resolver down, an exact screen name still opens, anything else
  answers "screen lookup unavailable" with no directive.
TEST: npx jest test/navigation/vtid-04846-registry-only.test.ts
AC-6: asking for the Audiobook or the full app on the way to My Journey
  switches the durable mode first (NAV_GUIDED_JOURNEY), and no other screen
  triggers it.
TEST: npx jest test/navigation/vtid-04846-registry-only.test.ts
AC-7: everything else unchanged: golden set, the 50-case redirect suite, the
  leave-one-out ratchet, the Command Hub surface isolation and the full gateway
  suite all pass.
TEST: npx jest test/nav-redirect test/navigation test/nav-golden

## Part 2 — the legacy navigator is deleted

Part 1 (#3892) made the registry answer every case. Part 2 removes what
nothing reaches any more:

- `lib/navigation-catalog.ts`, `lib/nav-catalog-db(-repository).ts`,
  `lib/nav-query-expansion.ts`, `services/navigator-consult.ts`, the
  `navigator` admin scanner, the seed/sync/generator scripts
  (`nav:sync`/`nav:check`), `lib/spa-routes-fallback.ts`.
- The boot warmers: the 60 s `nav_catalog` Supabase poll, and the batch
  embedding call over the static catalog that ran on every gateway start.
- Every `NAV_V2_ENABLED` branch: the registry is the only navigator. The flag
  leaves the conversation-flag registry. The deploy workflows still set it,
  inert, so the production workflow is not touched here.
- `/api/v1/admin/navigator/*` keeps only `GET /telemetry`, which now also
  reads the registry navigator's events (owner decision 2026-10-02). The
  vitana-v1 pages were retired in VTID-04853, already merged.
- `writeNavigatorActionMemory` moved unchanged to
  `navigation/nav-action-memory.ts`.

AC-8: the admin Navigator API serves telemetry only. Telemetry counts opened
  screens, misses (none or unavailable) and near ties from registry events,
  and still reads legacy events in the same window.
TEST: npx jest test/routes/admin-navigator-telemetry.test.ts
AC-9: no source file imports the deleted modules or reads `NAV_V2_ENABLED`.
  The registry guarantees of VTID-04513 and VTID-04519, and the 67 legacy
  DEVHUB ids, still hold.
TEST: npx jest test/vtid-04513-matches-route.test.ts test/vtid-04519-removed-home-subpages.test.ts test/navigation/vtid-04814-command-hub-navigation.test.ts test/services/conversation/vtid-04525-conversation-flag-registry.test.ts
AC-10: the instruction and tool catalogue are the ones production already
  served under NAV_V2 (snapshots re-recorded with the flag gone). The full
  gateway suite passes: 1,465 suites, 23,376 tests, 0 failed.
TEST: npx jest test/orb/live/characterization test/orb/latency/vtid-04542-voice-payload-identity.test.ts

## Not in this change

- The `nav-catalog` surface of the db-i18n pipeline (the I18N-DB-SEED daily
  cron and `scripts/nav/generate-nav-catalog-translations.mjs`), plus the two
  health checks that read `nav_catalog_i18n` coverage. That is a separate
  cleanup in the translation pipeline.
- Dropping the `nav_catalog*` tables. It can't be undone, so it is left for
  an explicit decision.
- Removing `NAV_V2_ENABLED` from the deploy workflows. The setting is inert
  now.
- The LiveKit agent's tool wrappers do not pass entity ids or `intent` yet.
