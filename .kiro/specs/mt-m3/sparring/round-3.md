# Sparring round 3 — escalated

Session: `8a83bc72-709d-4234-8481-0e260cd2771f` · plan hash `ecfb4a6ff91fe8573e1210b9d0d749584589d7c02813ac8fb8b7892ce0c92c73`

## Summary

Round 3 review of mt-m3. All three R2 findings were accepted and properly addressed in the revised plan. The host arm now correctly references lookupTenantMembership, the reserved-slug guard is a trigger (not CHECK), and the arm-ordering wording is fixed. Two new issues found: (1) the host arm's `unavailable → 503` behavior is incompatible with getTenantContext's current return type, and (2) lane 6's target route is ambiguous between unauthenticated and admin-gated routes in admin-health.ts.

## Findings

### R3-F1 [major]

The plan states the host arm's membership re-check behaviour as 'unavailable → 503 as :671-679', but getTenantContext() (the function the host arm is being added to) returns `TenantContext | null` and has no mechanism to signal a 503 response. When the existing token arm gets `unavailable` from lookupTenantMembership at line 641-642, it simply returns null — it does NOT return 503. The 503 path at :671-679 (applyTenantMembershipResult) is a separate function used in a different code path (the requireAuth middleware). The plan conflates these two code paths. If the implementer models the host arm on getTenantContext's existing pattern, 'unavailable' would return null and fall through to the next arm (token/primary), silently ignoring the host resolution — not 503. If the implementer instead implements 503, they must change getTenantContext's signature/behaviour (return type, or throw), which is a larger change than the plan acknowledges and affects all existing callers.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:635` — export async function getTenantContext(req: AuthenticatedRequest): Promise<TenantContext | null> { ... if (lookup !== 'member') return null; ... }
- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:656` — function applyTenantMembershipResult(req: AuthenticatedRequest, res: Response, lookup: MembershipLookup): boolean { ... if (lookup === 'unavailable') { ... res.status(503).json({ ok: false, error: 'TENANT_CHECK_UNAVAILABLE' ... }); return false; }

Suggestion: Specify the host arm's unavailable handling within getTenantContext's current contract. Either: (a) unavailable on the host arm falls through to the next arm (like the token arm does at :642, returning null) — safe, consistent, no signature change, but state this explicitly instead of citing 503; OR (b) the host arm returns a new status variant (e.g. getTenantContext returns a tagged union like PrimaryTenantResult) that the auth middleware maps to 503 — but then name the signature change and audit all callers. Option (a) is lowest risk for a standard change.

### R3-F2 [major]

Lane 6 says per-tenant isolation counts and erp.bootstrap_requested will be surfaced 'on the existing admin health read (services/gateway/src/routes/admin-health.ts)' but does not pin which route. That file contains both unauthenticated routes (/health at :63, /build-info at :74, /health-registry at :113) and admin-gated routes (/health/summary at :143 behind requireAdminAuth, /feature-flags at :174 behind requireAdminAuth). If the implementer adds per-tenant isolation data to an unauthenticated route, it would publicly expose per-tenant table counts and ERP-flag status — an information leak. The file's own comment (lines 12-14) warns: 'If you ever want to attach sensitive fields, gate them behind requireAdminAuth — never weaken the public response.'

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-health.ts:63` — router.get('/health', (_req: Request, res: Response) => { return res.status(200).json({ ok: true, env: VITANA_ENV, ... }); });
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-health.ts:12` — If you ever want to attach sensitive fields, gate them behind requireAdminAuth — never weaken the public response. `/feature-flags` (added below) follows that rule: it is admin-gated, and the two public responses above are unchanged.
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-health.ts:143` — router.get('/health/summary', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => { ... });

Suggestion: Pin lane 6 to an admin-gated route: either extend /health/summary (behind requireAdminAuth) or add a new /health/tenant-isolation route behind requireAdminAuth. Explicitly name the auth gate in the plan so the implementer cannot accidentally add per-tenant data to the public /health or /health-registry endpoints.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and properly addressed. The plan now correctly references lookupTenantMembership() with its cache/fail-closed semantics, removes the is_member() reference, and adds contract tests H2/H3.
- R2-F2: acknowledged — Accepted and properly addressed. The plan now specifies a BEFORE INSERT OR UPDATE trigger tenant_domains_reject_reserved() instead of a CHECK constraint, with rollback and pgTAP coverage.
- R2-F3: acknowledged — Accepted and properly addressed. The plan now correctly describes the host arm as a new first arm ahead of the unchanged token and primary arms, with no mention of nonexistent slug/claim arms in the gateway.
