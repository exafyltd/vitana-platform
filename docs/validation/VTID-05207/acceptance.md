# VTID-05207 acceptance: gateway side of "Say Hello" (suggestion endpoint + greeting guard)

Change types: Backend, Integration (guard branch in POST /api/v1/chat/send). No Database change (reads existing columns), no Infrastructure/CI.

Plan: `docs/validation/VTID-05207/plan-sparring.md` (plan hash `f7cdefc3043249c5`). Owner decision D2 = b: the greeting is a private DM on explicit Send, never auto-sent.

- AC-1: `POST /api/v1/community/new-member/:userId/greeting-suggestion` is authenticated, rate limited per viewer, returns `{ suggestion, language }` composed in the sender's locale, Bedrock only, capped, first name only.
  TEST: `npx jest test/vtid-05207-greeting-suggestion.test.ts` (services/gateway)
- AC-2: The suggestion route only suggests: it never inserts a DM, and a composer failure answers 503.
  TEST: `npx jest test/vtid-05207-greeting-suggestion-route.test.ts` (services/gateway)
- AC-3: The route is mounted on the deployed build and rejects an unauthenticated caller with a JSON 401 (not an SPA HTML page).
  CURL: `POST /api/v1/community/new-member/00000000-0000-4000-8000-000000000001/greeting-suggestion` without credentials expects 401 JSON (staging-tests.json, read-only).
- AC-4: The greeting guard refuses with one generic 403 when the receiver blocked or muted the sender, is not opted in, joined more than 7 days ago, either party is a test or service account, a greeting to the pair already exists, or the hourly cap is exceeded.
  TEST: `npx jest test/vtid-05207-greeting-guard.test.ts` (services/gateway)
- AC-5: Guard lookups fail closed (a lookup error refuses), and the pair and hourly reads are bounded by sender, receiver and created_at before the metadata.source tag is tested (finding F13).
  TEST: `npx jest test/vtid-05207-greeting-guard.test.ts` (services/gateway)
- AC-6: In POST /chat/send a refused greeting is a 403 with no insert and no notification; an allowed greeting flows on to the push grouping; an untagged ordinary DM is unchanged.
  TEST: `npx jest test/vtid-05207-greeting-guard-send-route.test.ts test/vtid-05208-greeting-send-route.test.ts` (services/gateway)
- AC-7: The calendar invite guard and adjacent chat send behaviour are unaffected.
  TEST: `npx jest test/vtid-05104` (services/gateway)
- AC-8: The gateway type checks.
  TEST: `npx tsc --noEmit` (services/gateway)

Captured real output is in `docs/validation/VTID-05207/outputs/`. Red-on-base: the guard and suggestion modules do not exist on `origin/main` (import failure), and the base `chat.ts` has no guard call, so the refusal scenarios fail there.
