# VTID-05730 — lane `stripe-dance-signature` (plan `gateway-critical-route-auth`)

Base: `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.
Branch: `kiro/gateway-critical-route-auth/stripe-dance-signature`.

## Change
- `services/gateway/src/index.ts:615-616`: `app.use('/webhooks/stripe-dance', express.raw({ type: 'application/json' }))`,
  next to the Stripe Connect raw parser and before `app.use(express.json({ limit: '2mb' }))`.
- `services/gateway/src/routes/payments-stripe-webhook.ts` (`POST /webhooks/stripe-dance`): before any read or write,
  `STRIPE_WEBHOOK_SECRET` unset → 500 `WEBHOOK_NOT_CONFIGURED`; no `stripe-signature` header → 400 `MISSING_SIGNATURE`;
  body not raw bytes, or `Stripe.webhooks.constructEvent(rawBody, sig, secret)` throws → 400 `BAD_SIGNATURE`. The state
  logic (`STATE_BY_EVENT`, lookup, update, OASIS events) is unchanged and runs on the verified event, not on parsed
  `req.body` JSON. The header comment no longer says unsigned payloads are accepted.
- Verification uses the static `Stripe.webhooks` of `stripe@20.3.1` (`node_modules/stripe/types/index.d.ts:321`), so no
  `STRIPE_SECRET_KEY` is needed. `routes/stripe-connect-webhook.ts:103-117` uses the instance form via `getStripe()`,
  which throws without `STRIPE_SECRET_KEY`.

## Acceptance criteria
All tests are in `services/gateway/test/payments-stripe-dance-signature.test.ts`. The test app mirrors index.ts (raw
parser for the path, then `express.json()`, router at `/`), mocks `routes/payments-stripe-webhook-repository.ts`,
`lib/supabase` and `services/oasis-event-service`, and signs fixtures with `Stripe.webhooks.generateTestHeaderString`.

| AC | Behaviour | TEST |
|----|-----------|------|
| AC-1 | Signed `payment_intent.succeeded` fixture → 200, `updateServicePaymentState(sb, 'pay_dance_1', 'authorized')` | `valid signature → 200 and the service_payments state moves` |
| AC-2 | Signature made with a different secret → 400 `BAD_SIGNATURE`, no lookup, write or OASIS event | `forged signature (signed with another secret) …` |
| AC-3 | Malformed signature header → 400 `BAD_SIGNATURE`, nothing written | `garbage signature header …` |
| AC-4 | No `stripe-signature` header → 400, nothing written | `missing stripe-signature header …` |
| AC-5 | `STRIPE_WEBHOOK_SECRET` unset → 500 `WEBHOOK_NOT_CONFIGURED`, nothing written | `STRIPE_WEBHOOK_SECRET unset …` |
| AC-6 | Body changed after signing → 400 `BAD_SIGNATURE`, nothing written | `body altered after signing …` |
| AC-7 | Verified event keeps the existing lookup-error (500 `LOOKUP_FAILED`) and unknown-PI (200 `unknown_pi`) paths | `signed event, lookup error …`, `signed event, unknown payment_intent …` |
| AC-8 | index.ts mounts the raw parser for the path before `express.json()` | `index.ts mounts express.raw for /webhooks/stripe-dance before express.json()` |

## AC mapping (Validator Check format)
AC-1 Signed `payment_intent.succeeded` → 200 and the state moves to `authorized`.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("valid signature → 200 and the service_payments state moves")
AC-2 Signature made with another secret → 400 `BAD_SIGNATURE`, nothing read or written.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("forged signature (signed with another secret)")
AC-3 Malformed signature header → 400 `BAD_SIGNATURE`, nothing written.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("garbage signature header")
AC-4 No `stripe-signature` header → 400, nothing written.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("missing stripe-signature header")
AC-5 `STRIPE_WEBHOOK_SECRET` unset → 500 `WEBHOOK_NOT_CONFIGURED`, nothing written.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("STRIPE_WEBHOOK_SECRET unset")
AC-6 Body changed after signing → 400 `BAD_SIGNATURE`, nothing written.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("body altered after signing")
AC-7 Lookup-error and unknown-PI paths unchanged on a verified event.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("signed event, lookup error", "signed event, unknown payment_intent")
AC-8 Raw parser for the path is mounted before `express.json()`.
TEST: services/gateway/test/payments-stripe-dance-signature.test.ts ("index.ts mounts express.raw for /webhooks/stripe-dance before express.json()")

## Results
- Red on base (origin/main versions of both source files in place): 8 failed, 1 passed of 9. The passing case is AC-4,
  because base already returned 400 for a missing header when the secret is set. `outputs/jest-red-on-base.txt`.
- Green: 9 passed of 9. `outputs/jest-green.txt`.
- `npx tsc --noEmit --preserveSymlinks` (services/gateway): exit 0. `outputs/tsc-gateway.txt`. `--preserveSymlinks`
  is needed because `node_modules` is a symlink to another worktree; without it, `declaration: true` gives 59 `TS2742`
  errors in files this lane does not touch, identical on base.
- Existing tests touching these files or raw parsers: 8 suites, 102 passed of 102. `outputs/jest-existing.txt`.
- `test/routes/payments-stripe-webhook.test.ts` was rewritten for signed events (outside plan §4's path list; done on
  the owner's instruction for this pass). It sets `STRIPE_WEBHOOK_SECRET` to a test value in `beforeAll` and restores it
  in `afterAll`, mounts `express.raw()` for the path before `express.json()` as index.ts does, and signs each event with
  `Stripe.webhooks.generateTestHeaderString`. Its three behaviours and every assertion are unchanged: lookup error →
  500 `LOOKUP_FAILED`, no update, error OASIS event; unknown payment_intent → 200 `unknown_pi`, info event; found
  payment → 200 and the update to `authorized`. 3 passed of 3 with the lane code. With the base route file and
  index.ts in place it fails 3 of 3 (each gets 400: the base handler reads the raw Buffer as the event and answers
  `BAD_PAYLOAD`). `outputs/jest-existing-webhook-on-base.txt`.

## Owner decisions and rollout
- The owner decides which signing secret the Stripe endpoint for `/webhooks/stripe-dance` uses and sets
  `STRIPE_WEBHOOK_SECRET` to it. This lane sets no secret. If the deployed value is not this endpoint's signing secret,
  Stripe deliveries get 400 until it is corrected. If it is unset, they get 500. Today they are accepted unsigned.
- Production is unchanged until an owner PUBLISH.
- `staging-tests.json` uses an `existing` jest ref instead of an http probe. The route rejects with 400/500, and
  `scripts/ci/staging-verify/lib.cjs:169` only allows write probes with `rejected_probe` and `expect_status` 401|403.
  `validateManifest(..., { service: 'gateway' })` returns `{ ok: true }`.

## Route mount evidence (Validator Check)
No route is added: the routes and their mounts exist on `main`; the change inserts a middleware or verification into existing registrations.
ROUTE_MOUNT: unchanged — `services/gateway/src/index.ts:1425` (router at `/`); raw-body parser added for `/webhooks/stripe-dance` before `express.json`
FINAL_URL: POST /webhooks/stripe-dance (paths unchanged)
CURL_PROOF: not run. No live or staging request was made; the staging proof is `staging-tests.json`, run by STAGING-VERIFY after a staging deploy, recorded here only with a run id.
