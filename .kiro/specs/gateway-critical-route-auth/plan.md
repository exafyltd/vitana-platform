---
change_class: standard
---
# plan(gateway-critical-route-auth): close three of the four critical unauthenticated gateway write paths (semantic memory, Stripe dance webhook, worker orchestrator) with existing gates
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repo `exafyltd/vitana-platform`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.
<!-- plan:begin -->
Pin: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. A lane on a newer `origin/main` re-verifies its citations.

## 1. Goal
Owner, 2026-11-11 ("Execution Directive Update", §4): *"Continue VTID-05698's manual investigation [...] The SB-CON-22
finding is serious and must remain a high-priority security workstream."* Then: *"come on, speed up"*. VTID-05698
(`docs/programs/security/gateway-write-route-inventory.md` on branch `kiro/gateway-write-route-auth/write-route-inventory`,
PR #4960) rates seven routes critical. This plan closes six of them; `POST /api/v1/events/ingest` is left to a next plan
because its callers include a GitHub Action that would need a repository secret (owner decision).

Not authorised: production deploy or PUBLISH, secrets or repository variables, migrations (the claim fail-open in
`claim_vtid_task` stays with the autonomy-risk plan), new auth middleware.

## 2. Today (evidence)
- Semantic memory: `routes/semantic-memory.ts:169` (search), `:251` (write), `:334` (context) take the `ContextLens`
  (`tenant_id`, `user_id`, `:54-62`) from the request body and pass it to `semanticSearch` / `writeMemoryItem` /
  `buildSemanticContext` (`:204`, `:281-294`, `:363-368`), which use the service-role client
  (`services/supabase-semantic-memory.ts:275-287`). No router-level or inline auth (`router.` calls at `:169,251,334,396,427,541,585`).
  `POST /admin/embeddings/generate` (`:427`) and `/reembed` (`:541`) are likewise open. Mounted at `/api/v1/memory`
  (`index.ts:1209`). No caller found in either repository (VTID-05698 §4, FU-3).
- Stripe dance webhook: `routes/payments-stripe-webhook.ts:42-47` only checks that a `stripe-signature` header exists when
  `STRIPE_WEBHOOK_SECRET` is set and never verifies it; `:51-112` moves `service_payments` state. Mounted at `/`
  (`index.ts:1425`); no raw-body parser (compare `index.ts:614,616`). The verified pattern is
  `routes/stripe-connect-webhook.ts:103-117` (`constructEvent` on the raw body, 500 when the secret is unset).
- Worker orchestrator: 12 write routes (`routes/worker-orchestrator.ts:223,317,362,519,891,989,1230,1332,1379,1447,1589,1715`)
  with no auth; mounted at `/` (`index.ts:870`). In-repo callers send no Authorization:
  `services/autopilot-event-loop.ts:530-533`, the ORB tools through `gatewayApiCall`
  (`services/orb-tools/developer-tools.ts:112-117`, used by `vtid-lifecycle-tools.ts:364,428` and
  `worker-orchestrator-tools.ts`); `mcp/vitana-work/src/lib/gateway-client.ts:89` sends `Bearer <apiKey>`. The
  worker-runner has no source in the repo (AR-12). Existing gate: `requireServiceOrAdmin` and the in-process header
  `gatewayServiceAuthHeader()` (`middleware/require-service-or-admin.ts:64-106`).

## 3. Interfaces between lanes
Three lanes, disjoint files. `stripe-dance-signature` is the only lane that edits `index.ts` (one raw-body line).
`worker-orchestrator-auth` edits the route file and its in-repo callers. No lane edits a file of PR #4955.

## 4. Lanes
### Lane `semantic-memory-auth` (seat `exafy`)
`requireAuthWithTenant` on search, write and context; the lens `tenant_id` and `user_id` come from `req.identity`
(a body lens with a different tenant or user → 403, never used); `requireAdminAuth` on `/admin/embeddings/generate` and
`/reembed`. Tests (supertest, mocked services): no token → 401; body lens naming another user → 403 and no service call;
own lens → handler runs with the identity's ids; admin routes refuse a non-admin. Red on the pin, green after.
Paths: `services/gateway/src/routes/semantic-memory.ts`, `services/gateway/test/semantic-memory-auth.test.ts`,
`docs/validation/VTID-*/**`.

### Lane `stripe-dance-signature` (seat `exafy`)
Raw-body parser for `/webhooks/stripe-dance` in `index.ts` (next to `:614`); the handler verifies with
`constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` as `stripe-connect-webhook.ts:103-117`; missing secret → 500
`WEBHOOK_NOT_CONFIGURED`, missing or bad signature → 400, nothing written. Tests with a signed fixture (Stripe's
`generateTestHeaderString`): valid → state moves; forged → 400 and no write; unset secret → 500. Which signing secret
the Stripe endpoint uses is the owner's (no secret is set by the lane).
Paths: `services/gateway/src/routes/payments-stripe-webhook.ts`, `services/gateway/src/index.ts`,
`services/gateway/test/payments-stripe-dance-signature.test.ts`, `docs/validation/VTID-*/**`.

### Lane `worker-orchestrator-auth` (seat `exafy`)
`requireServiceOrAdmin` on the 12 write routes; every in-repo caller sends `gatewayServiceAuthHeader()` (event loop,
`gatewayApiCall`); the lane first records a caller census in `commands.log`. Tests: each route no token → 401, service
token → handler runs; the event-loop dispatch and `gatewayApiCall` send the header. The worker-runner (no source) is named
in the PR body as a caller that must send the service token before production. No migration; the claim fail-open of
`:1260-1264` stays with the autonomy-risk plan.
Paths: `services/gateway/src/routes/worker-orchestrator.ts`, `services/gateway/src/services/autopilot-event-loop.ts`,
`services/gateway/src/services/orb-tools/developer-tools.ts`, `services/gateway/test/worker-orchestrator-auth.test.ts`,
`docs/validation/VTID-*/**`.

## 5. Parallel / hot files
Parallel. `index.ts` is shared with other plans but not on the hot list; the lane adds one line.

## 6. Tests and commands
Per lane the new jest file red on the pin and green after; the existing tests of the touched files; `npm run typecheck`;
`npm run build`; preflight. Each deploying lane ships `staging-tests.json` with rejected probes (401/400) only.

## 7. Measurement
Six critical routes closed (3 semantic + stripe + 2 orchestrator, plus the other 10 orchestrator writes); STAGING-VERIFY
run id per lane.

## 8. Risks
- An unknown production caller of the semantic or orchestrator routes gets 401. Mitigation: census per lane; production
  changes only on an owner PUBLISH, after reading the caller logs.
- Stripe: if production's `STRIPE_WEBHOOK_SECRET` is not this endpoint's signing secret, events get 400 until the owner
  sets it; today they are accepted unsigned.

## 9. Unchanged
`events/ingest` (next plan), migrations, secrets, flags, RLS, auth middleware, PR #4955's files.
<!-- plan:end -->
