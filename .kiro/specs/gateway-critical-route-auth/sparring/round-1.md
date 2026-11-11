# Sparring round 1 — in_progress

Session: `1b7281e5-4ef2-4db6-835a-4cdc45dde8bc` · plan hash `f88686d45c8f71a88733b11eadbce31d2e525a139099b59d94f1865ca9c1d542`

## Summary

Plan is well-structured with accurate premises. The stripe-dance, semantic-memory, and worker-orchestrator security findings are all confirmed by the code. Three issues found: one major gap in the caller coverage for the worker-orchestrator-auth lane (ambiguous fix strategy that could leave ORB-tool callers broken), one minor auth omission on an admin GET endpoint, and one minor middleware naming mismatch that could derail implementation.

## Findings

### R1-F1 [major]

The worker-orchestrator-auth lane's fix strategy for in-repo callers is ambiguous, risking broken ORB-tool call paths. The plan says 'every in-repo caller sends gatewayServiceAuthHeader() (event loop, gatewayApiCall)' and lists developer-tools.ts and autopilot-event-loop.ts in Paths. But vtid-lifecycle-tools.ts (lines 364, 428) and worker-orchestrator-tools.ts (lines 86, 135, 174) also POST to worker-orchestrator write routes via gatewayApiCall — and neither file is in the lane Paths. If the fix is to globally modify gatewayApiCall in developer-tools.ts to inject gatewayServiceAuthHeader(), these callers are covered transitively. But if an implementer instead adds auth headers at individual call sites (matching the existing pattern in vtid-lifecycle-tools.ts which imports serviceAuthHeaders from ledger-write-auth at line 20 for other routes), these two files would be missed and their calls would start getting 401. The plan must explicitly state whether gatewayApiCall is modified globally or per-call-site.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/vtid-lifecycle-tools.ts:364` — const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/route', {
      method: 'POST',
      body: {
        vtid: target.vtid,
        title,
        task_family: typeof args.task_family === 'string' ? args.task_family : 'DEV',
        task_domain: typeof args.task_domain === 'string' ? args.task_domain : undefined,
      },
    });
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/vtid-lifecycle-tools.ts:428` — const { ok, status, body } = await gatewayApiCall('/api/v1/worker/subagent/complete', {
      method: 'POST',
      body: { ... },
    });
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/worker-orchestrator-tools.ts:174` — const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/route', {
      method: 'POST',
      body: { vtid, title, ... },
    });
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/developer-tools.ts:110` — export async function gatewayApiCall(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${gatewayBaseUrl()}${path}`, {
    method: init?.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/vtid-lifecycle-tools.ts:20` — import { serviceAuthHeaders } from '../../middleware/ledger-write-auth';

Suggestion: Explicitly state in the plan that gatewayApiCall in developer-tools.ts will be modified to globally inject gatewayServiceAuthHeader() as a default header (caller-provided headers overriding via spread). This makes the transitive coverage of vtid-lifecycle-tools.ts and worker-orchestrator-tools.ts clear and testable. The lane tests should include a case verifying that a gatewayApiCall to a requireServiceOrAdmin-gated route succeeds when GATEWAY_SERVICE_TOKEN is set.

### R1-F2 [minor]

The plan protects POST /admin/embeddings/generate (line 427) and POST /admin/embeddings/reembed (line 541) with requireAdminAuth, but omits GET /admin/embeddings/status (line 585). This endpoint is under the /admin/ prefix and returns operational data about the embedding pipeline (whether items need embeddings, whether the migration is available). Leaving it open is inconsistent with the admin-auth intent of the other two endpoints.

- `exafyltd/vitana-platform:services/gateway/src/routes/semantic-memory.ts:585` — router.get('/admin/embeddings/status', async (req: Request, res: Response) => {
  try {
    const itemsResult = await getItemsNeedingEmbeddings(1);
    const embeddingStatus = isEmbeddingServiceAvailable();
    return res.json({
      ok: true,
      vtid: VTID,
      embedding_service: embeddingStatus,
      items_needing_embeddings: itemsResult.ok ? itemsResult.items.length > 0 : 'unknown',
      migration_available: itemsResult.ok,
      timestamp: new Date().toISOString()
    });

Suggestion: Add requireAdminAuth (or requireServiceOrAdmin) on the GET /admin/embeddings/status route as well, for consistency with the other admin endpoints in the same router.

### R1-F3 [minor]

The plan names the middleware 'requireAdminAuth' for the admin semantic-memory routes, but the existing admin-auth middleware in require-service-or-admin.ts is named 'requireAdminOnly' (line 110). If no middleware named requireAdminAuth exists elsewhere in the codebase, the implementer would either use the wrong name (causing a compile error) or inadvertently create new middleware, violating the plan's 'no new auth middleware' scope constraint.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-service-or-admin.ts:110` — export function requireAdminOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {

Suggestion: Clarify in the plan whether 'requireAdminAuth' refers to the existing requireAdminOnly from require-service-or-admin.ts, or to a different middleware (and if so, cite the file and export). If it is requireAdminOnly, update the plan to use the correct name.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
