# Sparring round 1 — in_progress

Session: `d5edc866-9ce1-4b2a-be19-7ac9b40321be` · plan hash `1fdcd8dd5b9c68d6aa1c3a09d76c8a2b01c5b0734c602bb413b82932a37b3844`

## Summary

The plan is well-constructed and its core premises about the existing codebase hold up under verification. DEV_IDENTITY values, VITANA_BOT_USER_ID, the NULL-fallback writers, the NOT NULL constraints on hot tables, the d46/d48/d49 engine issues, and the d48/d49 SQL migration no-fallback claims all check out against the pinned code. One minor gap found regarding the d48 route handler.

## Findings

### R1-F1 [minor]

Lane 5 lists only engine files as fixes (d46-anticipatory-guidance-engine.ts:153, d48-opportunity-surfacing-engine.ts:894/917, d49-risk-mitigation-engine.ts:519), but for d48 the actual tenant source is routes/opportunity-surfacing.ts — whose extractUserContext() (lines 75-93) never decodes the JWT auth header (line 81: 'For now, fall through to dev sandbox handling') and contains its own DEV_IDENTITY at lines 54-57. In the authenticated, non-dev-sandbox path the function returns null (line 92), producing a 401. The route is either dead code in production or funnels DEV_IDENTITY. Lane 5 should explicitly include this route in its fix scope (or state that the engine-level empty/…0001 guard makes the route fix unnecessary for this plan's purpose).

- `exafyltd/vitana-platform:services/gateway/src/routes/opportunity-surfacing.ts:54` — const DEV_IDENTITY = {\n  USER_ID: '00000000-0000-0000-0000-000000000099',\n  TENANT_ID: '00000000-0000-0000-0000-000000000001'\n};\n...\nfunction extractUserContext(req: Request) {\n  const authHeader = req.headers.authorization;\n  if (authHeader && authHeader.startsWith('Bearer ')) {\n    const token = authHeader.substring(7);\n    // In production, decode JWT to get user/tenant IDs\n    // For now, fall through to dev sandbox handling\n  }\n  if (isDevSandbox()) {\n    return { userId: DEV_IDENTITY.USER_ID, tenantId: DEV_IDENTITY.TENANT_ID };\n  }\n  return null;\n}
- `exafyltd/vitana-platform:services/gateway/src/routes/opportunity-surfacing.ts:150` — const input: OpportunitySurfacingInput = {\n  user_id: userContext.userId,\n  tenant_id: userContext.tenantId,

Suggestion: Add routes/opportunity-surfacing.ts to lane 5's explicit fix list (fix extractUserContext to resolve the caller's primary tenant via resolvePrimaryTenant or the request identity), or document that the engine-level guard (reject empty/…0001 before insert) is sufficient and the route fix is deferred to another lane.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
