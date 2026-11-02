# Responses to round 1

```json
[
  {"finding_id":"R1-F1","disposition":"accepted","rationale":"Premises re-read on vitana-v1 origin/main c3d71c83e740893169957fc8ff72ab70133eeeda: src/pages/admin/InitEvents.tsx exists; App.tsx:433 is the lazy import; App.tsx:2217 is the unguarded <Route path=\"/admin/init-events\" element={<InitEvents />} />; App.tsx:2192-2193 is the <AuthGuard><ProtectedRoute requiredRole=\"admin\"> sibling pattern. plan.md now names the pinned vitana-v1 commit and quotes the lines; tasks.md P2b tells the lane to re-read them on its base and, if the route moved, wrap it at the new line, or if removed/already guarded, record that and make no change.","deferred_to":""},
  {"finding_id":"R1-F2","disposition":"accepted","rationale":"Typo fixed: plan.md §Migrations range is now 20261102070000–20261102075959; every file timestamp already used 20261102.","deferred_to":""},
  {"finding_id":"R1-F3","disposition":"accepted","rationale":"The structural guard in mt-tenant-admin-scope-helper.test.ts now also flags bracket access (identity['tenant_id']), destructured tenant_id from an expression mentioning identity, and aliases of identity (const { identity } = req; const id = req.identity), besides dotted reads and any targetTenantId token. One inline fixture per form is asserted flagged and a helper-only fixture asserted clean, so the detector is itself tested. Kept to the one Jest mechanism; no ESLint rule added. plan.md (round-1 answers + Fix section) and tasks.md A6 updated.","deferred_to":""}
]
```
