# VTID-04513 — "open my matches" opened the news feed

VTID: VTID-04513

## What happened (staging, 2026-09-24 16:08:44)

Vitana offered to open the matches screen. `navigate` chose `HOME.MATCHES`
(`orb.navigator.requested route=/home/matches`). The frontend redirects
`/home/matches` to `/home` (VTID-01900 removed the Home sub-pages), and
`/home` is the Longevity News feed. The DB `nav_catalog` row for
`HOME.MATCHES` points at `/home` as well.

## Fix

`HOME.MATCHES` routes to `/me/matches`, the real "People who match you" page
(`MatchesPage`), and the SPA route list includes it.

## Acceptance

AC-1: `HOME.MATCHES` routes to `/me/matches`.
TEST: services/gateway/test/vtid-04513-matches-route.test.ts

AC-2: No catalog entry routes to a path the frontend redirects to the news feed (`/home/matches`, `/dashboard/matches`).
TEST: services/gateway/test/vtid-04513-matches-route.test.ts

AC-3: The navigation-catalog route lookup resolves `/me/matches` to `HOME.MATCHES`; the golden navigation set still passes.
TEST: services/gateway/test/navigation-catalog.test.ts

AC-4 (post-deploy, staging): "open my matches" lands on the matches page.
UI: https://preview-aws.vitanaland.com, ask Vitana to open your matches

## Not fixed here

- The DB `nav_catalog` row for `HOME.MATCHES` still says `/home`; the live
  navigator uses the code catalog. Changing the shared DB row is left to the
  owner (it also affects production).
- `HOME.CONTEXT`, `HOME.ACTIONS` and `HOME.AI_FEED` route to paths that also
  redirect to `/home`; a request for them lands on the news feed too.
