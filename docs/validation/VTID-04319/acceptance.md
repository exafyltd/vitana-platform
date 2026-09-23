# VTID-04319 — Orchestrator v2 P1: context resolver, agent registry v2, run ledger (shadow)

Phase P1 of `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §5, approved by the platform
owner 2026-09-23. Shadow only: nothing re-routes through the new pieces yet and
no plane writes anything new.

## What changes

- `services/orchestrator/context.ts` — `resolveAgentContext` (§3.1): platform
  role (VTID-04318 rule), `role_source`, org memberships
  (`partner_organization_members`), surface (`resolveOrbSurface`), channel,
  exafy flag, locale. Reads fail soft.
- Migration `20260923120000_vtid_04319_orchestrator_run_ledger.sql` (§3.3, §3.5),
  applied live 2026-09-23: `agent_runs` / `agent_run_steps` / `agent_run_signals`
  (native ledger, empty), `agent_runs_unified` (projection over Dev Autopilot,
  community AP and self-healing runs), agent-card columns on `agents_registry`
  plus seed (3 retired agents disabled, 5 unregistered agents added).
- `services/orchestrator/run-ledger.ts` + `routes/orchestrator.ts`, mounted at
  `/api/v1/orchestrator`: `GET /context` (any signed-in user, own context),
  `GET /runs`, `GET /runs/summary`, `GET /agents` (exafy_admin). Read-only.

The Command Hub Orchestrator view v0 is a separate PR that consumes these routes.

## Acceptance criteria

AC-1 `resolveAgentContext` returns one context (role, role source, orgs, surface, channel) and a failed read leaves only that field empty.
TEST: services/gateway/test/vtid-04319-orchestrator-p1.test.ts

AC-2 Run query normalisation bounds the limit and rejects unknown statuses; per-plane summary counts are correct.
TEST: services/gateway/test/vtid-04319-orchestrator-p1.test.ts

AC-3 `/context` requires a signed-in user; `/runs`, `/runs/summary`, `/agents` require exafy_admin; no handler writes.
TEST: services/gateway/test/vtid-04319-orchestrator-p1.test.ts

AC-4 The migration is additive, the ledger tables and view are service-role only, the view is `security_invoker`, and it covers every existing run plane.
TEST: services/gateway/test/vtid-04319-orchestrator-p1.test.ts

AC-5 Live, after apply: the view unifies the existing runs of all three planes; `anon`/`authenticated` have no SELECT; RLS is on.
TEST: services/gateway/test/vtid-04319-orchestrator-p1.test.ts

## Route evidence

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/orchestrator', orchestratorRouter, { owner: 'orchestrator' })`
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/orchestrator/{context,runs,runs/summary,agents}`
CURL_PROOF: pre-merge the routes are exercised in-process (supertest, AC-3). Post-deploy check on staging: unauthenticated `GET /api/v1/orchestrator/runs` must return `401 application/json` (route exists, auth enforced), never `404 text/html`. Result recorded in outputs/staging-curl.txt after the deploy.

## OASIS

OASIS_PROOF: no new event types in P1 (read-only). The native ledger is written from P4 on.

## Results

| AC | Result |
|---|---|
| AC-1 | MET — 3 resolver tests + 4 pure-builder tests green |
| AC-2 | MET — 2 tests green |
| AC-3 | MET — 5 route tests green, the Supabase stub throws on any write |
| AC-4 | MET — 3 migration tests green |
| AC-5 | MET live — see outputs/live-apply.txt |
