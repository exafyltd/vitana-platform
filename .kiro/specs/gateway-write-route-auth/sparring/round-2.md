# Sparring round 2 — converged

Session: `7a80327a-1275-425e-806b-6303a634e352` · plan hash `458e8adee544484323f173e4f9b16925bf5f5aa1074c454bd0faa05f4f4be3cb`

## Summary

The revised plan adequately addresses all three R1 findings. The caller census, the triage stream follow-up, and the scoped static assertion are now described. I verified key premises (middleware signatures, route locations, mounts, downstream service function signatures) and they hold. One new minor finding about the `getControlPlaneActor` → downstream service function mapping.

## Findings

### R2-F1 [minor]

The plan says both the ai-personality and routing-policy routes will derive audit actor fields from `getControlPlaneActor`, but `getControlPlaneActor` returns a single combined string (e.g. `'admin:<user_id>'` or `'service:internal'`), while all downstream service functions expect two separate fields: `updateRoutingPolicy` needs `actor_id` + `actor_role` (llm-routing-policy-service.ts:283,314-315), `resetToDefaults` needs `{ actor_id, actor_role }` (llm-routing-policy-service.ts:355), and `updatePersonalityConfig`/`resetPersonalityConfig` need separate `updatedBy` + `updatedByRole` (ai-personality-service.ts:489-490). The plan does not specify the mapping from the single control-plane actor string to these two separate fields, risking inconsistent audit records or an implementer guessing.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-service-or-admin.ts:137` — /** Read the control-plane actor label set by the gates above (for audit logs). */
export function getControlPlaneActor(req: Request): ControlPlaneActor {
  return (req as ActorRequest).__control_plane_actor ?? 'unknown';
}
- `exafyltd/vitana-platform:services/gateway/src/services/llm-routing-policy-service.ts:354` — export async function resetToDefaults(
  request: { actor_id: string; actor_role: string; reason?: string },
  environment: string = 'DEV'
- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:485` — export async function updatePersonalityConfig(
  surfaceKey: PersonalitySurfaceKey,
  newConfig: Record<string, unknown>,
  reason: string,
  updatedBy: string,
  updatedByRole: string
): Promise<{ ok: boolean; error?: string }> {

Suggestion: Specify the mapping explicitly: for `requireAdminOnly`, `optionalAuth` will have already populated `req.identity` (with `user_id` and `exafy_admin`), so the handler can use `req.identity.user_id` as `updatedBy`/`actor_id` and a literal `'exafy_admin'` as the role. For `requireServiceOrAdmin`, split the `getControlPlaneActor` string on `:` (e.g. `'service:internal'` → id `'internal'`, role `'service'`; `'admin:<uuid>'` → id `'<uuid>'`, role `'admin'`). Alternatively, export the identity/actor-type pair from the middleware directly (e.g. `getControlPlaneActorParts(req): { id: string; role: string }`) so the mapping is centralised and testable.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The plan now includes a full caller census at the pin with line numbers and caller counts, the openclaw-bridge caller is identified and handled (fail closed), and the static test now asserts per-route call-site count plus buildContextHeaders usage.
- R1-F2: acknowledged — Accepted and deferred appropriately. The plan now explicitly lists the triage stream GET as a proposed follow-up in the inventory lane with severity, notes the EventSource limitation preventing a bearer gate, and proposes a stream-token design for a future sparred plan. The deferral reasoning is sound.
- R1-F3: acknowledged — Accepted and addressed. The plan confirms 'x-actor-' occurs exactly once in app.js at the header being removed, and the test now also asserts on extracted call sites so a later unrelated use wouldn't cause a false positive.
