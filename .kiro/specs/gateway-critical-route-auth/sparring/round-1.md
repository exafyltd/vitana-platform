# Sparring round 1 — in_progress

Session: `1bec58bd-688c-4dc2-b2b7-89557b27d5f3` · plan hash `9cb941f5b02db26793546fcb537e80792fc7e88cf7bb21ab93dcb55569d861a4`

## Summary

Plan is well-structured with accurate file/line citations for the majority of premises verified. Three findings raised: one major regarding the MCP gateway client whose auth token type is unaddressed by the plan, one major regarding the GATEWAY_SERVICE_TOKEN env-var dependency for in-process callers, and one minor regarding an unverified premise about worker-orchestrator-tools.ts callers.

## Findings

### R1-F1 [major]

The plan lists `mcp/vitana-work/src/lib/gateway-client.ts:89` as a caller that 'sends Bearer <apiKey>' to worker-orchestrator routes. After adding `requireServiceOrAdmin`, this call will be rejected unless the apiKey is either the GATEWAY_SERVICE_TOKEN or a valid exafy_admin JWT. The plan does not clarify what `apiKey` is or how it will pass the new auth gate — it only mentions the worker-runner as needing to 'send the service token before production' without addressing the MCP client.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-service-or-admin.ts:71` — export function requireServiceOrAdmin(req, res, next): void { const token = extractBearer(req); if (!token) { res.status(401)... } if (matchesServiceToken(token)) { ... next(); return; } optionalAuth(req, res, () => { const id = ...; if (id && id.exafy_admin === true) { ... next(); return; } res.status(id ? 403 : 401)... });

Suggestion: Add to the caller census: confirm whether the MCP gateway client's apiKey is the GATEWAY_SERVICE_TOKEN, an admin JWT, or something else. If it's a separate API key, it will fail the requireServiceOrAdmin gate and the MCP work surface breaks. Either (a) confirm it already uses the service token, (b) plan an update to the MCP client, or (c) explicitly name it as a known breakage deferred to an owner PUBLISH like the worker-runner.

### R1-F2 [major]

autopilot-event-loop.ts:530 and self-healing-reconciler.ts:164 both use raw `fetch()` with no Authorization header. The plan correctly plans to add `...gatewayServiceAuthHeader()` to their fetch calls. However, `gatewayServiceAuthHeader()` returns an empty object `{}` when `GATEWAY_SERVICE_TOKEN` is unset (line 64: `return t ? { Authorization: \`Bearer ${t}\` } : {};`). If the env var is missing in any environment (staging, production), these callers silently send no header and get 401 — the autopilot pipeline and self-healing reconciler both break silently with no explicit error about the missing config. The plan should add a startup-time or first-use guard that fails loudly if the token is absent.

- `exafyltd/vitana-platform:services/gateway/src/services/autopilot-event-loop.ts:530` — const routeResponse = await fetch(`${gatewayUrl}/api/v1/worker/orchestrator/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({...}) });
- `exafyltd/vitana-platform:services/gateway/src/services/self-healing-reconciler.ts:164` — const dispatchRes = await fetch(`${GATEWAY_URL}/api/v1/worker/orchestrator/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({...}), signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS), });
- `exafyltd/vitana-platform:services/gateway/src/middleware/require-service-or-admin.ts:63` — export function gatewayServiceAuthHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> { const t = env.GATEWAY_SERVICE_TOKEN ?? ''; return t ? { Authorization: `Bearer ${t}` } : {}; }

Suggestion: Add a startup-time or first-dispatch guard: if GATEWAY_SERVICE_TOKEN is unset when either caller first tries to dispatch, log a loud error and/or emit an OASIS event so the misconfiguration is immediately visible rather than silently producing 401s. Alternatively, add a preflight check in the lane's staging-tests.json that confirms the variable is set.

### R1-F3 [minor]

The plan references `worker-orchestrator-tools.ts:86,135,174` as callers covered by the gatewayApiCall path-conditional header injection, but a code search for this file with gatewayApiCall returned no results. I could not verify that these call sites exist or that they use gatewayApiCall. If the file uses a different call mechanism (e.g. raw fetch), the path-conditional injection in gatewayApiCall would not cover them.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/developer-tools.ts:110` — export async function gatewayApiCall(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> { const res = await fetch(`${gatewayBaseUrl()}${path}`, { method: init?.method || 'GET', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, body: init?.body !== undefined ? JSON.stringify(init.body) : undefined, }); ...

Suggestion: Verify that worker-orchestrator-tools.ts exists at the pin, confirm its call sites use gatewayApiCall (not raw fetch), and list the actual line numbers. If it uses a different mechanism, add it to the explicit caller-edit list.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
