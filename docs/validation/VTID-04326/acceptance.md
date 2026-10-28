# VTID-04326 — commerce becomes its own ORB surface (Orchestrator plan §8.3)

Owner decision 2026-09-23: "Yes please — commerce becomes its own ORB surface".

## Acceptance criteria

AC-1: Voice sessions on /commerce, /commerce/*, /partner and /partner/*
resolve to the `commerce` surface; /commerce-login, /business/* and look-alike
prefixes stay on the community surface. Commerce wins over the mobile rule
because the commerce portal is mobile-adapted (VTID-03989).
TEST: services/gateway/test/orb/live/commerce-surface.test.ts

AC-2: On the commerce surface an authenticated session is offered only the
navigation tools and knowledge search: no community, health, diary, memory,
admin, backoffice or developer tools and no web grounding, whatever the
user's platform role. Anonymous sessions are not widened.
TEST: services/gateway/test/orb/live/commerce-surface.test.ts

AC-3: The `commerce_orb` persona exists as a valid ai_personality_config
surface key with voice_* intent fields only (no scripted spoken line,
NEVER rule 41), and the personal brain context is withheld on commerce the
same way it is on admin and backoffice (behavioural test on the built
instruction; mutation-verified: disabling the commerce branch fails 2 cases).
TEST: services/gateway/test/orb/live/commerce-surface.test.ts
TEST: services/gateway/test/orb/live/instruction/work-surface-overlays.test.ts

AC-4: The existing surfaces are unchanged (surface resolution, persona keys,
navigator roles, tool gates for vitanaland/admin/backoffice/command-hub).
TEST: services/gateway/test/orb/live/surface.test.ts

## Not in this slice

Commerce read tools (my organisation, team, order inbox) — planned next;
until then the assistant explains screens and navigates. Navigator catalog
rows for commerce screens do not exist yet, so the navigator returns no
community routes on this surface (same as backoffice today).
