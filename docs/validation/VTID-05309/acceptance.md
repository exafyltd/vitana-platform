# VTID-05309 — authorised message search (GET /api/v1/chat/search)

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/chat/search` — `routes/chat-search.ts`, mounted by `routes/chat.ts` (`router.use('/search', …)`) under the existing `/api/v1/chat` mount.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/search (staging; only an unsigned rejected probe is sent)

CURL_PROOF: staging answers 401 to an unsigned `GET /api/v1/chat/search?q=abc`; the search itself is proven in CI.

OASIS_PROOF: n/a — read-only endpoint.

## Acceptance criteria

AC-1: User C never sees an A↔B DM; a non-member never sees a group's messages; another tenant never (also with the tenant filter bypassed); a deleted group's rows never surface as a DM — enforced by the query filter AND a row-level check (the test's mock ignores the visibility filter).
  TEST: services/gateway/test/vtid-05309-chat-message-search.test.ts ("authorization")
AC-2: `scope=group:<id>` for a non-member → 403; `scope=dm:<peer>` returns only that DM.
  TEST: services/gateway/test/vtid-05309-chat-message-search.test.ts ("scope=group", "scope=dm")
AC-3: `q` < 3 chars → 400; LIKE wildcards are escaped (a `%` query matches a literal `%`); the filter value is quoted.
  TEST: services/gateway/test/vtid-05309-chat-message-search.test.ts ("query rules")
AC-4: `type=image` returns only messages whose attachments include an image (type or mime); file names match.
  TEST: services/gateway/test/vtid-05309-chat-message-search.test.ts ("type=image", "a file name matches")
AC-5: Newest first, cursor pagination by (created_at, id) — pages continue without overlap, a strict ISO cursor (else 400); snippet ±60 characters; per-member rate limit (30/min → 429).
  TEST: services/gateway/test/vtid-05309-chat-message-search.test.ts ("cursor", "short page", "snippet", "rate limit")
