# VTID-05211 — Gateway profile card list, and no dead Instagram/Facebook cards

Plan `profile-vitana-cards`, lane `gateway-profile-list` (Lane B). The owner made the request and approved it at
Gate 1 on 2026-10-15, and decided to hide E6/E7 until the Meta app exists. Sparring record: `plan-sparring.md`
(CONVERGED, 2 rounds, plan hash `92964488a27e7401`). This lane changes the gateway only: no migration, no new route,
no new env var, no OASIS event.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1 (R1, R5): `SCREEN_ENRICHMENT_CARDS.profile` is E1–E7 and E11, the same list as the frontend
`CARD_SCREENS.profile.allow` (VTID-05210). `GET ?screen=profile` serves E1, E2, E3, E6, E7, E4, E5, E11 in that order
when every card is open. Every other screen's list is unchanged.
  TEST: npx jest test/routes/enrichment-cards.test.ts -t "screen filtering"

AC-2 (R7): E6 is served only when `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` are both set, and E7 only when
`FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET` are. This holds on every screen that lists them (home, profile,
community, messenger). The cards come back as soon as the clients exist, with no other change. The check reuses
`isProviderConfigured()` (VTID-04402), the same check the social-connect route depends on.
  TEST: npx jest test/routes/enrichment-cards.test.ts -t "Meta OAuth clients"

AC-3 (R3): `profile_completion_pct` still counts all of E1–E11, including E6/E7, whatever is shown. Dismissals,
cooldown and boost cards are unchanged.
  TEST: npx jest test/routes/enrichment-cards.test.ts test/services/enrichment

AC-4 (staging, read-only): the route is still mounted, requires login, and the gateway is alive.
  TEST: staging-tests.json (http probes)
