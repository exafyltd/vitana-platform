# Sparring round 2 — converged

Session: `51e287cf-00e8-49b5-967c-773f516b79f5` · plan hash `8cc6fd60c7f63bafe250cc25a61750987b53bc8a64d1980eb6dc01689f6ce292`

## Summary

Round 2 review of mt-track-s-authz. All three accepted findings (R1-F1, R1-F2, R1-F4) are properly addressed in the revised plan. The rejected finding R1-F5 is correctly rejected (all line numbers verified). The deferred R1-F3 rationale is sound. One new minor finding about a UX gap in the developer voice tool path.

## Findings

### R2-F1 [minor]

Lane approvals-auth step 3 gates dev_approve_pr / dev_reject_pr on `!id.user_jwt` (the NO_ADMIN_SESSION pattern), but a non-exafy developer caller who DOES have a `user_jwt` will pass developerGate, pass the jwt-presence check, forward their JWT to the route, and hit a 403 from requireServiceOrAdmin ('forbidden — exafy_admin privileges required'). Today these callers CAN approve PRs through the voice tool (no auth on the route). After this change, they get a round-trip 403 with a generic error instead of a clear tool-level denial. The plan's §8 Risks mentions 'sessions without [a token] get the admin-session answer' but does not describe the non-exafy-with-JWT path.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-service-or-admin.ts:89` — // Path 2: JWT — must resolve to an exafy_admin identity.
    optionalAuth(req as AuthenticatedRequest, res, () => {
      const id = (req as AuthenticatedRequest).identity;
      if (id && id.exafy_admin === true) { ... }
      res.status(id ? 403 : 401).json({ ok: false, error: id ? 'forbidden — exafy_admin privileges required' : ... });
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/developer-tools.ts:35` — const DEVELOPER_ROLES = new Set(['developer', 'admin', 'exafy_admin']);
export function developerGate(id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) { return { ok: false, error: 'developer tools require an authenticated user.' }; }
  const role = String(id.role ?? '').toLowerCase();
  if (!DEVELOPER_ROLES.has(role)) { return { ok: false, error: 'developer_role_required' }; }
  return null;
}
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/admin-users-rbac-tools.ts:37` — export const NO_ADMIN_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_admin_session' },
  text: "This needs a signed-in admin session — I don't have one for this voice session.",
};
...
export const admin_lookup_user: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;

Suggestion: In dev_approve_pr/dev_reject_pr, after developerGate and before calling approvalsApi, also check that the identity is exafy_admin (e.g. `if (!id.user_jwt || !['exafy_admin'].includes(String(id.role).toLowerCase())) return NO_ADMIN_SESSION;`). This avoids the wasted round-trip and gives a clear tool-level message to non-exafy developers. Alternatively, document the non-exafy-with-JWT path in §8 Risks if the 403 pass-through is intentional.

## Acknowledgements of earlier responses

- R1-F3: acknowledged — Deferral rationale is sound. The GET routes need a paired frontend change in operator-console.js, which is a different change scope. Tracking as F1 in handoff.md is appropriate.
- R1-F5: acknowledged — Rejection is valid. All line numbers verified at the pin: conversation.ts:216, :497, :502, :520, :918 and tool-registry.ts:1364 are exactly as the plan states.
