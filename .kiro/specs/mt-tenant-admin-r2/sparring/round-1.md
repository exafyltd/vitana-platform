# Sparring round 1 — in_progress

Session: `2bb76919-dda6-4159-9ee2-ad79eab9545d` · plan hash `136f714e049234d96b1a09ebe110428cbbeb1ae559f4c385c2e80901ec352853`

## Summary

I verified the plan's key premises against the pinned vitana-platform commit. Most premises about the gateway codebase hold precisely. The vitana-v1 repo has no pinned ref in this session so all App.tsx/InitEvents premises are unverifiable (and search returns zero hits). I found one migration range typo and a concern about the structural guard test's regex coverage. Overall the plan is thorough and correctly describes the existing code's behavior.

## Findings

### R1-F1 [major]

The plan makes specific line-number claims about vitana-v1/src/App.tsx (lazy import at :433, unguarded route at :2217, admin guard pattern at :2192) and asserts InitEvents.tsx exists in vitana-v1/src/pages/admin/. These premises are the basis for the tenant-admin-pages lane's governance fix (wrapping the route in AuthGuard/ProtectedRoute). vitana-v1 has no pinned ref in this session, read_file errors out, and GitHub search returns zero hits for 'InitEvents' or 'init-events' in that repo. If the page or the unguarded route don't exist at the claimed locations, the guard fix in the tenant-admin-pages lane targets non-existent code, and a governance violation (ungoverned admin surface) may remain unaddressed.

- `exafyltd/vitana-platform:e2e/fixtures/routes.ts:193` — '/admin/init-events',

Suggestion: Provide the pinned vitana-v1 commit hash for independent verification, or include a screenshot/code excerpt of App.tsx lines 2210-2220 and the InitEvents lazy import in the plan itself, so a reviewer can confirm the unguarded route exists where claimed. If the file has been removed or moved on the default branch, update the lane accordingly.

### R1-F2 [minor]

The migration range is stated as '20261102070000–20261101075959' — the end date has '20261101' (November 1st) while the start date and all actual migration timestamps use '20261102' (November 2nd). This is a copy-paste typo that could cause confusion during migration ordering verification.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:193` — const PROVISION_VTID = 'VTID-05150';

Suggestion: Fix the range to '20261102070000–20261102075959'.

### R1-F3 [minor]

The structural guard test's bypass detection relies on matching 'identity.tenant_id', 'identity?.tenant_id' and 'targetTenantId' as string patterns. This misses destructured access (e.g. `const { tenant_id } = req.identity;`), bracket-notation (`req.identity['tenant_id']`), or aliased access (`const id = req.identity; ... id.tenant_id`). A file that bypasses the helpers using a destructured or aliased form would pass the guard test silently.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-autopilot.ts:23` — function getTenantId(req: Request): string {
  return (req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id;
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:30` — function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;

Suggestion: Widen the guard regex to also match `tenant_id` as a destructured property name (e.g. `/\btenant_id\b/` on lines that also reference `identity` or `req`), or add an ESLint rule that forbids importing AuthenticatedRequest's identity.tenant_id directly in files that import require-tenant-admin. Both existing divergent patterns use the dotted form, but a future contributor could use destructuring.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
