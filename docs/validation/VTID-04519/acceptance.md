# VTID-04519 — removed Home sub-pages sent members to the news feed

VTID: VTID-04519

## What happened

VTID-01900 (vitana-v1, 2026-04-15) replaced Home with the Longevity News
feed and removed its sub-pages: Context, Actions, Matches, AI feed. Their
routes redirect to `/home`. The navigator still listed all four, so "show me
my pending actions", "my context" or "my AI feed" opened the news feed.
VTID-04513 fixed Matches in the code catalog only.

Found while following up VTID-04513: the DB `nav_catalog` rows win over the
code catalog ("DB rows always win on conflict", `nav-catalog-db.ts`). The
shared DB rows for all four screens are active and route to `/home`, so the
code fix alone does not hold once the DB cache is loaded.

## Fix

- Code catalog: `HOME.CONTEXT`, `HOME.ACTIONS`, `HOME.AI_FEED` removed (no
  successor page exists). The "pending actions / tasks for today" intent is
  added to My Journey (`AUTOPILOT.MY_JOURNEY`), the Autopilot page that shows
  today's recommended actions.
- Data fix-up (`supabase/migrations/data-fixups/20260924210000_VTID_04519_nav_catalog_dead_home_routes.sql`):
  the shared `HOME.MATCHES` row routes to `/me/matches`; the other three rows
  are deactivated (`is_active=false`, never deleted, idempotent).
  **Not applied** — the table is shared by staging and production, so it
  changes production navigation the moment it lands. Owner decision.

## Acceptance

AC-1: `HOME.CONTEXT`, `HOME.ACTIONS`, `HOME.AI_FEED` are not in the code catalog.
TEST: services/gateway/test/vtid-04519-removed-home-subpages.test.ts

AC-2: No catalog entry routes to a path the frontend redirects to the news feed.
TEST: services/gateway/test/vtid-04519-removed-home-subpages.test.ts

AC-3: For a community member, "show me my pending actions" and "what tasks are pending for me" open My Journey.
TEST: services/gateway/test/vtid-04519-removed-home-subpages.test.ts

AC-4: The navigation golden set passes; the cases that named the removed screens now name My Journey or are removed.
TEST: services/gateway/test/navigation-catalog.test.ts

AC-5 (after the data fix-up is applied): the four `nav_catalog` rows read `/me/matches`, inactive, inactive, inactive; "open my matches" lands on the matches page.
UI: https://preview-aws.vitanaland.com, ask Vitana to open your matches
