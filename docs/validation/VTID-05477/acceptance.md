# VTID-05477 — new-member card listing served by the gateway (welcome-finish-r2 / new-members-feed-api)

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/community/new-members` — `routes/community-new-members.ts`, mounted in `index.ts` with `mountRouterSync(app, '/api/v1', communityNewMembersRouter, …)` next to `community-members`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/community/new-members (staging; only an unsigned rejected probe is sent)

CURL_PROOF: staging answers 401 JSON to an unauthenticated `GET /api/v1/community/new-members`; every listing behaviour is proven in CI with an in-memory database (staging writes are forbidden and shared with production).

OASIS_PROOF: n/a — a read-only listing emits no event.

## Acceptance criteria

AC-1: A test, service or bot account (`service_bot_accounts`, `notification_test_actors`) and the caller are never listed; the list still fills to the limit with real members.
  TEST: services/gateway/test/vtid-05477-new-members-feed.test.ts ("excludes service bots and test actors", "excludes the caller")

AC-2: A member who has not opted in, or withdrew the opt-in, is not listed on the next call; hidden profiles and members older than 7 days are not listed.
  TEST: services/gateway/test/vtid-05477-new-members-feed.test.ts ("excludes a member who has not opted in or withdrew", "excludes hidden profiles and members older than 7 days")

AC-3: If either exclusion table cannot be read the route answers 503 JSON `exclusion_lookup_failed` (fail closed), never a list.
  TEST: services/gateway/test/vtid-05477-new-members-feed.test.ts ("fails closed with 503 exclusion_lookup_failed")

AC-4: Unauthenticated requests get 401 JSON; an empty result is `{ ok: true, members: [] }`; the limit is clamped to 1..5 (default 5); there is no tenant filter (mirrors the browser query, sparring R1-F2).
  TEST: services/gateway/test/vtid-05477-new-members-feed.test.ts ("401 JSON without a token", "empty list is 200", "clamps the limit", "does not filter by tenant")

AC-5: The route file is claimed by a domain in the atlas and the role-separation regression stays green.
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts (`npm run test:roles`, 105 tests; `^community` already claims `community-new-members`, so `domain-atlas.ts` needs no edit)

Red on base: the new suite fails on `origin/main` because `src/routes/community-new-members.ts` does not exist (`outputs/red-on-base.txt`).
Not verified on staging with real data: staging writes are forbidden; only the 401 probe runs there.
