# VTID-04533 — search_events opens an event only when the member asks

## Owner report (staging, 2026-09-25 08:53 UTC, session live-43f4d5d0…)

The member asked "are there any other events except these two?". Vitana called
`search_events` for 2026-09-27 to 2026-10-31, which found exactly one event.
The tool treated a single result as "open it": it navigated to the event drawer
(`orb.search_events.auto_nav`), which closes the voice session, and told Vitana
to say "Opening 'The Future of Social Wellness'". The member's question was
never answered, and the session ended 0.6 s later.

## Fix

- New optional voice argument `open_event` (boolean).
- The tool auto-opens the drawer only when `open_event === true` AND the
  result is unambiguous, as before.
- A question that matches one event now gets the normal list answer
  (`decision: list_only`).
- The LiveKit agent passes only `query`, so it never auto-opens.

The added declaration bytes shift which tool sits at the edge of Nova's 64 KB
tool budget in four recorded replays: one tool in about 47. That tool stays
reachable through `find_tool`, and those snapshots were updated deliberately.

## Acceptance criteria

AC-1: A question whose search matches exactly one event is answered with the list; no directive, no auto_nav event.
TEST: services/gateway/test/orb-tools/vtid-04533-search-events-no-auto-open.test.ts

AC-2: Only `open_event === true` opens; a truthy string does not.
TEST: services/gateway/test/orb-tools/vtid-04533-search-events-no-auto-open.test.ts

AC-3: An explicit ask with an unambiguous result still opens the event drawer; with an ambiguous result it lists.
TEST: services/gateway/test/orb-tools/vtid-04533-search-events-no-auto-open.test.ts

AC-4: The voice declaration offers `open_event` as optional.
TEST: services/gateway/test/orb-tools/vtid-04533-search-events-no-auto-open.test.ts

## Mutation check

Against the previous tool code, 3 of the 5 new tests fail.

## Not verified here

This has not been tried in a live voice session. After merge, ask Vitana on
staging "are there any other events besides these?" when one event matches:
she should answer, and the ORB should stay open.
