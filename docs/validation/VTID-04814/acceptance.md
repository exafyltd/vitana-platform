# VTID-04814 — Command Hub screens in the screen registry (retire-legacy step 1)

## Problem (found while mapping, read-only)

`NAV_V2_ENABLED=true` is set on both gateways. `/command-hub` is not a
legacy surface, so on the Command Hub `navigate` ran through the registry
resolver — which only knew the 186 member screens and had no notion of a
surface. "Open Autopilot Live" could only resolve to a community page; the
Command Hub client refuses any route outside `/command-hub` and returned no
status, so the developer heard "opening…" and nothing happened. The
Command Hub also never declared `navigate_to_screen` (the registry's own
answers tell the model to call it), `dev_open_hub_panel` ran through the
generic dispatcher that never forwards a directive, and the widget's
`current_route` stayed on the first tab for the whole session.

The legacy catalog covers no `/admin`, `/staff`, `/professional`… app pages
at all; its only role-surface entries are 67 Command Hub screens. So this
step moves those, and the Command Hub is the first surface the registry
covers besides members.

## Acceptance criteria

- AC-1: every tab of the Command Hub's `NAVIGATION_CONFIG` (134) has exactly
  one registry screen (`src/navigation/data/command-hub-screens.json`,
  surface `command-hub`) and every screen is a real tab.
  TEST: npx jest test/navigation/vtid-04814-command-hub-navigation.test.ts
- AC-2: every one of the 67 legacy `DEVHUB.*` ids still opens (65 keep their
  id, the two whose tab moved are `formerIds` of the new tab).
  TEST: npx jest test/navigation/vtid-04814-command-hub-navigation.test.ts
- AC-3: on the Command Hub, 40 developer phrasings (35 English, 4 German)
  put the right screen first; no Command Hub request ever offers a member
  screen, and no member request (80 golden cases) ever offers a Command Hub
  screen.
  TEST: npx jest test/navigation/vtid-04814-command-hub-navigation.test.ts
- AC-4: `openScreen` refuses a member screen on the Command Hub and a
  Command Hub screen in the app (`wrong_surface`); an invented
  `DEVHUB.*.EVENTS` id no longer lands on the community Events page.
  TEST: npx jest test/navigation/vtid-04814-command-hub-navigation.test.ts
- AC-5: the Command Hub declares `navigate_to_screen`; `dev_open_hub_panel`
  goes through the navigation handler so its directive reaches the widget.
  TEST: npx jest test/navigation/vtid-04814-command-hub-navigation.test.ts
- AC-6: the Command Hub client reports `opened` / `refused` / `not_found`
  and updates the widget's `current_route` on every tab switch.
  CURL: GET <staging gateway>/command-hub/app.js?v=20261022-vtid-04814 contains `function syncOrbRouteWithCommandHub()`
- AC-7: member navigation unchanged — golden set, redirect suite and the
  leave-one-out ratchet pass with the Command Hub screens merged in (the
  evaluator now asks each phrasing on its own screen's surface).
  TEST: npx jest test/nav-redirect test/navigation test/nav-golden

## Known limits

- English only: the Command Hub is a developer tool. German works where the
  words resemble the English names; "Freigaben" does not reach Approvals.
- `get_current_screen` still reads the legacy catalog (step 2).
- Voice behaviour on a real Command Hub session is not verified here; the
  staging run proves the served client and the resolver tests prove the
  server. A spoken check on staging is the remaining manual step.
