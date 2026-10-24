# Sparring round 2 — in_progress

Session: `c351f749-3076-4fba-87b0-25aba2df8c15` · plan hash `0d5fe4921a7e33f269f13d46d6319b09bca483e18e08ec67e87157d48121ad90`

## Summary

R1-F1/F2/F3 were all correctly addressed in the revision. R1-F4 rejection is sound — the i18n stamp and propagate mechanics were verified directly against the code. Two new findings: a major one about the lane paths arrays being under-specified for new and modified files (App.tsx, useTenantMeta.ts, tenant-theme.ts, and CommerceJoin.tsx source), which cannot be corrected after lane-file creation per the cited queue.mjs constraints; and a minor one about the activeTenantSlug() call site in AuthGuard being unspecified.

## Findings

### R2-F1 [major]

The plan introduces src/hooks/useTenantMeta.ts (brand-surface-r2) and src/lib/tenant-theme.ts (theme-tokens-r2) as new files, modifies src/App.tsx in brand-surface-r2 (BR5: 'one import + one useTenantMeta();'), and modifies src/pages/CommerceJoin.tsx (B1/BR4) — yet none of these appear in the plan's Evidence base 'Full vitana-v1 paths of the files the lanes touch' list. The plan itself cites queue.mjs:585-587 ('_plan commit may create a lane file, never edit one') and queue.mjs:679-688 (paths changes in lane PRs rejected unless executor: claude) as the immutability constraints. The BR3 pre-push gate is 'git diff --name-only origin/main...HEAD ⊆ paths'. If the lane files are created without these paths, every push fails the scope check with no repair path short of a full re-plan. The plan explicitly states that 'Both CommerceJoin tests are now in paths' but is silent on whether the CommerceJoin.tsx production file, App.tsx, useTenantMeta.ts, and tenant-theme.ts are declared in the respective lane files.

- `exafyltd/vitana-v1:src/hooks/useTenant.tsx:38` — export function TenantProvider({ children }: { children: React.ReactNode }) {
- `exafyltd/vitana-v1:src/main.tsx:25` — import { TenantProvider } from './hooks/useTenant'
- `exafyltd/vitana-v1:src/App.tsx:469` — const AppHooksInitializer = () => {
- `exafyltd/vitana-v1:src/App.tsx:101` — const CommerceJoin = lazy(() => import("./pages/CommerceJoin"));

Suggestion: Before the lane files are stamped, enumerate the complete paths array for each lane explicitly in the plan. For brand-surface-r2 this must include at minimum: src/pages/CommerceJoin.tsx, src/hooks/useTenantMeta.ts, src/App.tsx, src/i18n/*/tenantBrand.json (glob or enumerated), src/pages/CommerceJoin.oauth-first.test.ts, src/pages/CommerceJoin.routing.test.ts, src/hooks/useTenantMeta.test.ts, and all B2–B5 files already listed. For theme-tokens-r2 add src/lib/tenant-theme.ts and its test files. The BR3 pre-push gate ('git diff ⊆ paths') will catch any omission before the first push, but only if the lane file was already created correctly — there is no fix path after that point.

### R2-F2 [minor]

The plan introduces activeTenantSlug({ tenantSlug, candidates, registry }) as a pure function replacing the AuthGuard.tsx:267,271 literals, but never shows the actual call site. AuthGuard's only props are children and allowGuest (confirmed at lines 13-22) — it has no tenantSlug prop. The mapping of the stored slug from readStoredTenantSlug('tenant_slug') to either the tenantSlug or candidates parameter is left to the implementer to infer.

- `exafyltd/vitana-v1:src/components/AuthGuard.tsx:13` — interface AuthGuardProps {
  children: ReactElement;
  allowGuest?: boolean;
}
- `exafyltd/vitana-v1:src/components/AuthGuard.tsx:267` — localStorage.setItem('tenant_slug', readStoredTenantSlug('tenant_slug') || 'maxina');
              await supabase.auth.signInWithOAuth({
                provider: 'apple',
                options: {
                  redirectTo: window.location.origin + '/' + (readStoredTenantSlug('tenant_slug') || 'maxina'),

Suggestion: Add the literal replacement lines for AuthGuard.tsx:267 and :271 to the spec, e.g. const retrySlug = activeTenantSlug({ candidates: [readStoredTenantSlug('tenant_slug')], registry: currentRegistrySync() }), and confirm that 'tenantSlug' is always undefined at this call site (it exists to support future callers that already know the slug). This also clarifies whether the localStorage write at :267 keeps the validated slug or the raw stored value.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — gen-tokens.mjs confirmed in vitana-v1 at scripts/native/gen-tokens.mjs:97-104. The plan's evidence base now prefixes all vitana-v1 paths. Fully addressed.
- R1-F2: acknowledged — AuthGuard confirmed at src/components/AuthGuard.tsx:267,271. Planner confirmed the lane's paths array already carried the correct path. Fully addressed.
- R1-F3: acknowledged — Fix changed to useTenant().tenant?.slug ?? 'maxina' (no localStorage step). ResolvedTenant.slug confirmed at tenant-registry.ts:101. BR5 tests added for the three scenarios. Fully addressed.
- R1-F4: acknowledged — Rejection rationale verified in full. i18n-stamp-source.mjs:289/293/335-342 confirms unstamped != totalDrift and exit 1 only fires on mismatch. I18N-PROPAGATE.yml:88/110-115/122 confirms COUNT is drifted keys only and pivot is skipped when TOTAL=0. Shipping all 11 locales keeps both COUNT and MISSING at zero. The rejection is sound.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
