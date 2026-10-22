---
change_class: light
---
# plan(matches-scroll-end): the phone Matches list scrolls to its last card
<!-- plan:begin -->
## Problem
Owner report 2026-10-22 (Kiro Web, phone screenshot of `/me/matches`, "People who match you"): the list does not
scroll to the end. The last match stays hidden behind the bottom navigation bar and the Orb, so it can never be read or
tapped in full.

## Premises (read-only, `exafyltd/vitana-v1` @ `b8a4efbd31b43001f65150e6316056cfcde18248`, pinned for sparring in `handoff.md` `spar_refs`)
1. `exafyltd/vitana-v1:src/pages/MatchesPage.tsx` renders two trees. Spotlight (`useSpotlightEnabled()`, desktop + flag) uses
   `ScreenFrame`. Every phone gets the legacy tree, whose outer wrapper is
   `<div className="p-4 md:p-6 bg-gradient-to-br … min-h-screen">` (`:115`). Its only bottom padding is the 16 px of `p-4`.
2. On phones the document scrolls. `AppLayout` (`exafyltd/vitana-v1:src/components/AppLayout.tsx:493-513`) and
   `SidebarInset` (`exafyltd/vitana-v1:src/components/ui/sidebar.tsx:338`) use `min-h-*`, not a fixed height.
   `MobileAppShell` (`exafyltd/vitana-v1:src/components/mobile/MobileAppShell.tsx:60-64`) wraps the page in a
   `flex-1 min-h-0 overflow-hidden` div. No ancestor has a bounded height, so that div grows with its content and clips
   nothing vertically. The same holds one level up for `AppLayout`'s `<main className="flex-1 min-h-0 overflow-hidden">`
   (`exafyltd/vitana-v1:src/components/AppLayout.tsx:511`): the outer flex container is `min-h-screen`, not `h-screen`
   (`:493`), so no definite height is resolved anywhere in the chain. Scrolling ends when the bottom of the page content reaches the bottom of the viewport.
3. `MobileBottomNav` (`exafyltd/vitana-v1:src/components/mobile/MobileBottomNav.tsx:153`) is `fixed bottom-0`, about 72 px plus
   `env(safe-area-inset-bottom)`. The Orb FAB is `position: fixed`,
   `bottom: calc(var(--appilix-bottom-nav-height, 72px) - 46px)` (`exafyltd/vitana-v1:src/index.css:859-875`), about 72 px tall, so it
   reaches about 26–36 px above the bar (36 px in the owner screenshot). Both are drawn over the page, so the last ≈100 px of content are covered when
   scrolling ends.
4. Other phone pages leave room for the bar themselves: My Journey `pb-32` (`exafyltd/vitana-v1:src/pages/AutopilotDashboard.tsx:544`),
   `src/pages/MobileDailyDiary.tsx:111` / `src/pages/MobileSupport.tsx:529` `pb-[120px]`, `src/pages/MobileSettings.tsx:610` `pb-24`. `MatchesPage` has none. That is the
   bug.
5. `useRealMatches(50)` (`MatchesPage.tsx:44`) returns up to 50 rows and every row is rendered. Nothing is clipped by a count or a
   `max-h`/`overflow` on the list.

## Files to read (all in `exafyltd/vitana-v1` at the pinned ref)
Re-spar from session 1: both earlier sessions (#4300) failed every `read_file`, which is a gateway outage and not a
finding. The premises above rest on these files: `src/pages/MatchesPage.tsx`, `src/components/AppLayout.tsx`,
`src/components/ui/sidebar.tsx`, `src/components/mobile/MobileAppShell.tsx`, `src/components/mobile/MobileBottomNav.tsx`,
`src/index.css`, `src/pages/AutopilotDashboard.tsx`, `src/pages/MobileSettings.tsx`, and the test-style reference
`src/pages/vtid-05117-leftovers-2.test.tsx`.

## Change (one lane, `matches-list-clearance`, repo vitana-v1)
- `src/pages/MatchesPage.tsx`, legacy (phone) tree only: the outer wrapper gets bottom padding that clears the bar,
  the Orb and the safe area, and is reset on `md`:
  `pb-[calc(var(--appilix-bottom-nav-height,72px)_+_env(safe-area-inset-bottom,0px)_+_90px)] md:pb-6`
  (≈ 72 + inset + 90 px). The 90 px matches the existing fixed-overlay clearance of `.maxina-signin-page`
  (`exafyltd/vitana-v1:src/index.css:878-883`). It covers the Orb's observed ≤36 px overhang (the Orb is
  Appilix-injected and no height for it is defined in the repo), leaves ≥54 px of headroom if the Orb grows, and
  the code comment names that sizing. It is tied to the same CSS
  variable the Orb uses, so a different Appilix bar height moves both together. `p-4 md:p-6` stays for the other
  sides. The wrapper also gets `data-testid="matches-page"`.
- The Spotlight tree, the data hook, the list markup and the empty/loading states stay unchanged.
- Scrolling to the top is unchanged: the content already starts below the fixed `TopAppBar` (`MobileAppShell`
  `paddingTop: calc(env(safe-area-inset-top) + 32px)`), and the header is fully visible at scroll 0 (owner
  screenshot).

## Test plan
- New `src/pages/MatchesPage.bottom-clearance.test.tsx` (Vitest + RTL, mocks in the style of
  `src/pages/vtid-05117-leftovers-2.test.tsx`). With the flag off and 7 matches: all 7 rows render. The
  `matches-page` wrapper's class has the bottom-clearance padding (it references `--appilix-bottom-nav-height` and
  `safe-area-inset-bottom`), and `md:pb-6`. Red on `origin/main` (no `matches-page` wrapper, no padding), green on
  the lane head. jsdom has no layout, so the test checks the class contract; the scroll itself is checked on the
  staging build on a phone viewport (below).
- `npx vitest run src/pages/MatchesPage.bottom-clearance.test.tsx src/pages/vtid-05117-leftovers-2.test.tsx` green;
  `npx tsc --noEmit -p tsconfig.app.json` and lint on the changed files clean.
- Staging (read-only): `docs/validation/<VTID>/staging-tests.json` lists the Vitest suite (`kind: existing`). On the
  staging build, at a 390×844 viewport, `/me/matches` scrolled to the bottom shows the last card fully above the
  bottom bar and Orb.

## Lanes
- `matches-list-clearance` (vitana-v1, seat `exafyltd`, area `frontend`, executor `kiro`, `depends_on: []`). Paths:
  `src/pages/MatchesPage.tsx`, `src/pages/MatchesPage.bottom-clearance.test.tsx`, `docs/validation/VTID-*/**`. No hot
  file, no shared file, no governance path, no migration.

## Out of scope
- A shared "clear the bottom nav" layout primitive for every phone page (other pages already pad themselves).
- The Spotlight desktop tree.
<!-- plan:end -->
