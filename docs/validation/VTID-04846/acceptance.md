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

## Not in this step

- Deleting the legacy navigator, its boot warmers, the DB poll, the flag-off
  paths and their tests (next PR).
- Retiring the Catalog / Coverage / History admin pages (vitana-v1) and their
  gateway routes. Telemetry stays (owner decision 2026-10-02).
- The LiveKit agent's tool wrappers do not pass entity ids or `intent` yet.
  They go through the same dispatcher, so they gain the registry path but not
  entity opening.
