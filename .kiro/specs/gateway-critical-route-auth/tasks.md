# Tasks — gateway-critical-route-auth
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/gateway-critical-route-auth/<lane>`; trailers
`Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

Common acceptance:
- Change types: Backend, Tooling/docs.
- Only existing gates; new jest file red on the pin and green after (outputs in `docs/validation/<VTID>/outputs/`).
- Existing tests of touched files, typecheck and build pass; `staging-tests.json` has rejected probes only.
- No secret, variable, migration or production change.

<!-- lane: semantic-memory-auth -->
## Lane `semantic-memory-auth`
- [ ] T1 `requireAuthWithTenant` on search/write/context; lens ids from `req.identity`; mismatch → 403.
- [ ] T2 `requireAdminAuth` on `/admin/embeddings/generate`, `/reembed` and `GET /admin/embeddings/status`; existing suite updated.

**Acceptance**
- No token → 401; another user's lens → 403 with no service call; own lens → service called with the identity's ids.

<!-- lane: stripe-dance-signature -->
## Lane `stripe-dance-signature`
- [ ] T1 Raw body for `/webhooks/stripe-dance`; `constructEvent` verification; unset secret → 500.

**Acceptance**
- Signed fixture → state moves; forged or missing signature → 400 and no write; unset secret → 500.

<!-- lane: worker-orchestrator-auth -->
## Lane `worker-orchestrator-auth`
- [ ] T1 Caller census; `requireServiceOrAdmin` on the 12 write routes.
- [ ] T2 Event loop and reconciler send `gatewayServiceAuthHeader()`; `gatewayApiCall` adds it for `/api/v1/worker/*` only; existing suite sends the token.

**Acceptance**
- Each of the 12 routes: no token → 401, service token → handler runs; the two in-repo caller paths send the header.
- PR body names the worker-runner as a caller that must send the service token before production.
