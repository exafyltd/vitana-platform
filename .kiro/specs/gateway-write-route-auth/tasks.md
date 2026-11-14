# Tasks — gateway-write-route-auth
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/gateway-write-route-auth/<lane>`; title
`VTID-xxxxx (gateway-write-route-auth/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

<!-- lane: route-auth -->
## Lane `route-auth`
- [ ] T1 Add `requireServiceOrAdmin` to `PATCH /api/v1/specs/:vtid`, llm `POST /routing-policy` and
      `POST /routing-policy/reset`; `requireAdminOnly` to triage `/investigate`, ai-personality `PUT /:surface_key` and
      `POST /:surface_key/reset`. The gate is the first middleware of each route.
- [ ] T2 Remove the `x-actor-role` / `x-actor-id` reads and role allow-list in `routes/llm.ts`; take the audit actor from
      `getControlPlaneActor` in llm and ai-personality.
- [ ] T3 Command Hub callers `app.js:17974`, `:18009`, `:28670-28674` use `buildContextHeaders(...)`; no `x-actor-*` header.
- [ ] T4 Tests: `test/gateway-write-route-auth.test.ts` and `test/command-hub/gateway-write-route-auth-callers.test.ts`,
      red on the pin and green after; `staging-tests.json` with seven rejected probes (401).
- [ ] T5 Caller census (plan §2) re-run into `commands.log` (repo and vitana-v1); PR body states that the openclaw-bridge
      routing-policy writes fail closed until the owner approves a token.

**Acceptance**
- Change types: Backend, UI, Tooling/docs.
- Seven routes: no token → 401; non-admin JWT → 403; `exafy_admin` JWT → handler runs; `PATCH /specs/:vtid` and the two
  routing-policy routes also accept the service token; `x-actor-role: admin` alone → 401. The mocked write is never called on 401/403.
- Per route the static test counts exactly the census's write call sites in `app.js`, each with `buildContextHeaders(`;
  `app.js` contains no `'x-actor-role'` and no `'x-actor-id'`.
- Only existing middleware is used; no change to `auth-supabase-jwt.ts`, `require-service-or-admin.ts`, `index.ts`.
- Red-on-base proof for both test files in `commands.log`; `npm run typecheck` and `npm run build` pass.
- `staging-tests.json`: only `rejected_probe` entries without a token and `existing` jest refs; staging only.
- PR body states that production is unchanged until an owner-commanded PUBLISH.

<!-- lane: write-route-inventory -->
## Lane `write-route-inventory`
- [ ] T1 List every POST/PUT/PATCH/DELETE route in `services/gateway/src/routes/*.ts` and inline in `index.ts`, with
      mount path from `index.ts`.
- [ ] T2 Per route: gate, identity source, effect, callers, verdict (gated; gated in handler; public by design with
      reason; unauthenticated and needs a gate; Unknown); severity and proposed existing gate for "needs a gate".
- [ ] T3 Cross-reference the worker-orchestrator routes with the VTID-05686 autonomy risk register.
- [ ] T4 GET routes that serve data produced by the seven routes (triage stream first) and the openclaw-bridge
      routing-policy writes, each as a proposed follow-up with severity and gate design.

**Acceptance**
- Change types: Tooling/docs.
- Every write route of the pin has exactly one verdict with a `file:line`; counts per verdict match the table.
- The heuristic command and its output count (123 at the pin) are in `commands.log`; each heuristic hit is resolved.
- Every "needs a gate" row names an existing gate and its callers; no fix is presented as done.
- Only the lane `paths` change; no code.
