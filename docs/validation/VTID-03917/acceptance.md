# VTID-03917 — Command Hub Overview: 30s poll no longer forces a full renderApp()

## Reported issue

Live report against `preview-aws-gateway.vitanaland.com/command-hub/overview/system-overview/`:
the System Overview screen "flickering" and "frozen" (sidebar nav / top tabs not
responding to clicks), plus the sidebar nav list snapping back to the top whenever
scrolled ("when I scroll down it must stay down... when I scroll up it must stay in
position I have moved it to").

## Root cause

`renderOverviewSystemView()` arms a 30-second interval
(`state._actionRequiredTimer`) that calls `fetchActionRequired(true)`
(`silentRefresh=true`) while the Overview / System Overview tab is mounted.
`fetchActionRequired()`'s trailing `renderApp()` call was **unconditional** — it
ignored `silentRefresh` entirely and always did a full `root.innerHTML=''` +
rebuild of the whole app (sidebar, header, every card) every 30 seconds while
sitting on this tab. This is unlike its sibling `fetchServiceHealth(silentRefresh)`,
which already correctly branches a silent refresh to a lightweight pill update
instead of a full render.

A full rebuild every 30s on this tab:
- Is expensive (System Overview renders 50+ health rows, events, deploy cards),
  causing visible flicker and perceptible jank.
- Destroys and recreates every DOM node, including any element mid-click — a
  click whose mousedown/mouseup straddle a rebuild can land on nothing, reading
  as "frozen" navigation.
- Destroys and recreates `.nav-section` (the sidebar list). It IS tagged
  `data-scroll-retain="true"` / `data-scroll-key="sidebar-nav"` and its
  scrollTop is restored via `captureAllScrollPositions()`/
  `restoreAllScrollPositions()` — but that restore is deferred one extra
  `requestAnimationFrame` beyond the outer `renderApp()`'s own rAF, so the
  freshly rebuilt list visibly sits at `scrollTop=0` for one frame before
  snapping back — the reported "scroll doesn't stay" symptom, replayed every
  ~30 seconds while this tab is open.

## Fix

`fetchActionRequired()`'s `silentRefresh` branch now calls a new
`refreshActionRequiredPanel()` helper, which replaces only the
`.action-required-panel` DOM node in place via `renderActionRequiredPanel()` +
`Node.replaceWith()`, instead of calling `renderApp()`. The non-silent
(initial-load) path is unchanged. The same parity fix (skip the full render
when `silentRefresh` is true) is applied defensively to
`fetchOverviewTimeseries()`, even though no caller currently passes
`silentRefresh=true` to it — so a future caller cannot regress into the same bug.

## Acceptance Criteria

AC-1: The Overview tab's 30s auto-refresh no longer triggers a full-app
`renderApp()` rebuild (root.innerHTML clear + rebuild of sidebar/header/every
card) — only the Action Required panel's own DOM node is replaced.
TEST: `services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts`
  — "the silentRefresh branch calls refreshActionRequiredPanel(), not renderApp()"
  and "refreshActionRequiredPanel() replaces the existing .action-required-panel
  node in place" (asserts the helper never calls `renderApp()`).

AC-2: The 30s timer's call site is unchanged — it still requests a silent
refresh (`fetchActionRequired(true)`), so this is a pure internal-behavior fix,
not a change to polling cadence or scope.
TEST: `services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts`
  — "the 30s _actionRequiredTimer still calls fetchActionRequired with
  silentRefresh=true".

AC-3: A non-silent call (the initial mount of the Overview tab) still does a
full `renderApp()`, so first paint is unaffected.
TEST: `services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts`
  — "a non-silent call (initial load) still does a full renderApp()".

AC-4: `fetchOverviewTimeseries()` gets the same silentRefresh-skips-full-render
guard as its siblings, defensively, even though nothing calls it with
`silentRefresh=true` today.
TEST: `services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts`
  — "does not call renderApp() when silentRefresh is true".

AC-5: The fix matches the exact pattern the sibling `fetchServiceHealth()`
already uses for the same problem, so the codebase now has one consistent
silent-refresh idiom instead of two divergent ones.
TEST: `services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts`
  — "fetchServiceHealth() already branches silentRefresh away from a full
  renderApp() (unchanged reference behavior)".

AC-6: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both run
  as part of `commands.log` below, and by CI's own Bundle Syntax Gate,
  VTID-01011).

## Known limitation — not covered by this evidence pack

This session has no Command Hub admin login credentials for
`preview-aws-gateway.vitanaland.com` (Supabase-authenticated, requires a
`developer`/`admin`/`infra`/`staff`/`exafy_admin` role) and per this repo's own
rule never attempts to obtain or guess one. All verification above is static/
source-level (regression tests reading `app.js` as text, `tsc --noEmit`,
`npm run build`, the full jest suite) — **not** a live screenshot of the fix
running against staging, which CLAUDE.md's Targeted Visual Verification
protocol otherwise mandates for UI changes. `outputs/` is present (Evidence
Pack Gate requirement) but intentionally empty; there is nothing to screenshot
without a live session. Flagged explicitly to the platform owner as the next
manual verification step once this reaches staging.
