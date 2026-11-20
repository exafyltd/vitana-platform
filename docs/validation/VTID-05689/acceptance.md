# VTID-05689 acceptance (strategy-execution-wave1/destination-identity)

Change types: Tooling/docs. Deliverable: `docs/programs/strategy-execution/destination-identity-strategy.md` (DOC below).
Every AC is checked against the working tree of this lane; the command outputs are in `commands.log`.

AC-1 DOC header names Status, Owner, pinned HEADs of both repos (and the strategy input), the VTID and the plan link.
TEST: grep -c -E '^- \*\*(Status|Owner|Pinned HEADs|VTID|Plan):\*\*' DOC (expect 5)

AC-2 The current default identity is listed with file:line: the domain map, `/` and `ShareEntry`, `/auth`, the guest and
AuthGuard fallbacks, the tenant-registry Maxina fallback, the Maxina golden test, the native identifiers and scheme,
and MULTI-TENANT-PLAN §4.8.
TEST: grep -c for `domain-tenant-mapping.ts:5-8`, `App.tsx:818`, `App.tsx:831`, `guest-auth.ts:24-26`,
`tenant-registry.ts:75-88`, `maxina-golden.test.tsx:114`, `app.config.ts:27-30`, `app.config.ts:217`,
`MULTI-TENANT-PLAN.md:60` in DOC (each >= 1)

AC-3 Every `path:line` citation (repo-prefixed for vitana-v1 and the strategy input) exists in the pinned checkout with
enough lines; 0 failures.
TEST: node docs/validation/VTID-05689/check-citations.mjs DOC

AC-4 The principles are stated: vitanaland.com is the ecosystem, Maxina an independent destination whose character
belongs only to Maxina (with the repository spelling "Mariia Maksina" noted), Vitana the universal companion.
TEST: grep -c for "vitanaland.com is the ecosystem", "Maxina is an independent destination", "Vitana is the universal
companion", "Mariia Maksina" in DOC (each >= 1)

AC-5 The migration-aware path is ordered and keeps Maxina working: golden unchanged until a sparred plan changes it,
store identifiers immutable once published, ecosystem landing behind a flag, coordination with `mt-frontend-brand-r3`
and `mt-packs-r2` cited from their plan and lane files.
TEST: grep -c for "Store identifiers are immutable once published", "ships dark", ".kiro/specs/mt-frontend-brand-r3/plan.md",
".kiro/specs/mt-packs-r2/plan.md", "lanes/brand-surface-r3.md", "lanes/persona-pack.md" in DOC (each >= 1)

AC-6 No identity, domain, bundle or data migration is performed; every change is a proposed follow-up with title,
files, risk, owner and gate.
TEST: grep -c '| ID | Title | Files | Risk | Owner | Gate |' DOC (expect 1); AC-7 shows no code file changed

AC-7 Only the lane paths change; no code, schema, flag, workflow, `CLAUDE.md`, `areas.yaml` or multi-tenant spec file.
TEST: git -C <worktree> status --porcelain (only paths under scope.json `paths`)

AC-8 scope.json passes the PR-GATE scope validator.
TEST: node -e "validateScope(scope.json, 'VTID-05689')" from scripts/ci/pr-gate/lib.mjs returns []

AC-9 No live system is called: commands.log contains only local git, grep, node and file commands.
TEST: grep -E '^\$ ' commands.log | grep -v '#AC-9' | grep -c -E '(curl|psql|supabase |aws |gh |wget)' (expect 0)

AC-10 Collab tests pass; nothing is deployed.
TEST: node --test scripts/collab/*.test.mjs

AC-11 Plain English, no em-dash chains.
TEST: grep -c '—' DOC (expect 0)
