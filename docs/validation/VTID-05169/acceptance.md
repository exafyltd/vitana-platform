# VTID-05169 — acceptance (Life Timeline P3: Timeline API)

ROUTE_MOUNT: services/gateway/src/routes/timeline.ts (new) → mounted in src/index.ts via mountRouterSync at /api/v1/timeline (owner 'timeline'); atlas domain 'memory' claims /^timeline$/.
FINAL_URL: GET {gateway}/api/v1/timeline, GET {gateway}/api/v1/timeline/spotlight, GET {gateway}/api/v1/timeline/summary, GET {gateway}/api/v1/timeline/:id, POST {gateway}/api/v1/timeline/:id/hide-from-ai, DELETE {gateway}/api/v1/timeline/:id
CURL_PROOF: on staging only the anonymous GETs (staging-tests.json): `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/timeline` → `401 application/json` (also /spotlight, /summary). Authenticated reads and the two writes are proven in Jest (staging shares the production database; writes are never probed).
OASIS_PROOF: not applicable; no event is emitted or changed.

AC-1 Every endpoint requires a JWT user and filters every read/write by it (never a body value).
TEST: npx jest test/routes/vtid-05169-timeline.test.ts -t "auth|scoped to the JWT|before/after"

AC-2 Spotlight: score, tier KEY, five pillars with today's change (from movements only) and 7-day momentum (±5),
balance factor → penalty % and reason key (`timeline.balance.full|held_back`) with the weakest pillar, today's top
contributors (nightly `daily` excluded); null before a first score.
TEST: npx jest test/routes/vtid-05169-timeline.test.ts -t "GET /spotlight"

AC-3 List: Index day cards (sum of the day's movements), "Your day" digest (≥3 digest rows, special-category never
counted), moments newest first; influence `measured` only from a movement (own movement_id, or the nearest
wearable_sync movement within 5 min), else `counted` toward the pillar/secondary pillar; summary is `{key, params}`
with only catalog params; pillar/category validated; pillar filter matches the secondary pillar; cursor paging.
TEST: npx jest test/routes/vtid-05169-timeline.test.ts -t "GET /|reader units"

AC-4 Before the VTID-05167 migration is applied the list classifies rows in process from the same catalog and never
lists silent or system rows (e.g. orb.livekit.next_action.candidate, page.view).
TEST: npx jest test/routes/vtid-05169-timeline.test.ts -t "before the VTID-05167 migration"

AC-5 Detail returns the moment with its Index before/after and whether Vitana uses it; silent/system rows 404;
hide-from-ai validates the body, answers 409 before the migration, 404 for another member's id; delete 404/200.
TEST: npx jest test/routes/vtid-05169-timeline.test.ts -t "GET /:id, hide, delete"

AC-6 No regression: typecheck; roles suite (atlas claims the new route file).
TEST: npx tsc --noEmit -p services/gateway; npx jest test/vtid-04560-role-separation-regression.test.ts
