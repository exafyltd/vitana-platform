# Sparring round 1 — in_progress

Session: `c351f749-3076-4fba-87b0-25aba2df8c15` · plan hash `ed0ba5940f5f990af789aac1f9cbb334d73f371105234d9fa324aef80107c5ac`

## Summary

Round-1 adversarial review of mt-frontend-brand-r2. Thirteen of fifteen stated premises were confirmed by direct read_file calls against the pinned SHAs. Two could not be confirmed: scripts/native/gen-tokens.mjs is absent from vitana-platform (directory 404); src/pages/AuthGuard.tsx is absent from vitana-v1 (file 404). Three substantive findings are raised: the gen-tokens file and its cited behaviour are unverifiable; the wrong AuthGuard path will cause lane-scope failure when B2 is committed; replacing the 'maxina' literal with a localStorage-fallback hook at the permanent supabase.auth.signUp metadata call site removes an explicit invariant on a database write. One minor i18n stamp deadlock risk is also raised.

## Findings

### R1-F1 [major]

scripts/native/gen-tokens.mjs cannot be confirmed to exist in vitana-platform at the pinned SHA. The plan cites it at :97-104 as the behavioral basis for rejecting the CSS-fallback and var(x,fallback) approaches in theme-tokens-r2, and lists 'gen-tokens.mjs --check exits 0' as a required green test step. The scripts/native/ directory in vitana-platform returned 404. If the file does not exist in either repo the cited premises are unverifiable and the test step cannot run.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:620` — export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {

Suggestion: Identify the canonical repo and path of gen-tokens.mjs (it may live in vitana-v1 root scripts/). Read the file, confirm the :97-104 substitution behavior, and add it to the evidence base. If the file does not exist at all, remove 'gen-tokens.mjs --check' from the test matrix and replace it with whatever mechanism actually validates packages/ drift.

### R1-F2 [major]

AuthGuard.tsx is not at src/pages/AuthGuard.tsx in vitana-v1 at the pinned SHA (read_file returned 404). The plan cites AuthGuard.tsx:267,271 as the B2 '|| maxina' literals that the lane owns and AuthGuard.tsx:74 as the readStoredTenantSlug usage pattern. If the lane's paths array carries the wrong path, the B2 commit touches a file outside declared paths and the lane-scope check fails at merge time.

- `exafyltd/vitana-v1:src/hooks/useTenant.tsx:1` — import { canonicalTenantSlug, readStoredTenantSlug } from "@/lib/retired-tenants";
- `exafyltd/vitana-v1:src/lib/retired-tenants.ts:61` — export function readStoredTenantSlug(key: (typeof TENANT_SLUG_STORAGE_KEYS)[number] = 'tenant_slug'): string | null {

Suggestion: Search for the real AuthGuard file path (e.g. src/components/auth/AuthGuard.tsx or src/guards/AuthGuard.tsx). Update the plan's evidence base with the real path and line numbers, and ensure the lane's paths array uses that path so the scope check passes.

### R1-F3 [major]

BR4 replaces the literal 'maxina' at all three CommerceJoin.tsx call sites (lines 142, 149, 176) with useActiveTenantSlug(), whose fallback chain reads readStoredTenantSlug() from localStorage when no authenticated tenant is active. Line 176 passes tenant_slug into supabase.auth.signUp options.data, which Supabase stores in user_metadata permanently at account-creation time. If any non-null, non-maxina value is in localStorage['tenant_slug'] at sign-up time the new account is permanently linked to the wrong tenant. D13 mitigates this today, but the plan does not treat line 176 differently from the OAuth write (line 142) or the OAuth query param (line 149), and adds no explicit fallback guard at this call site.

- `exafyltd/vitana-v1:src/pages/CommerceJoin.tsx:140` — localStorage.setItem('tenant_slug', 'maxina'); ... queryParams: { tenant_slug: 'maxina' } ... data: { full_name: fullName, tenant_slug: 'maxina', preferred_role: 'community' }
- `exafyltd/vitana-v1:src/lib/retired-tenants.ts:61` — export function readStoredTenantSlug ... stored = localStorage.getItem(key) ... return canonical;

Suggestion: Keep the literal 'maxina' specifically at line 176 (signUp data.tenant_slug), consistent with the comment at :9-12 that CommerceJoin is Maxina-only by design. Alternatively, add an explicit guard: const signupSlug = useActiveTenantSlug() ?? 'maxina'. Add a Vitest assertion that line 176 always resolves to 'maxina' even when localStorage holds a non-maxina slug.

### R1-F4 [minor]

BR2 ships src/i18n/de/tenantBrand.json (a brand-new namespace) but i18n-source-stamps/** is deliberately excluded from the lane's paths. If i18n-stamp-source.mjs must create a stamp entry for the new namespace before i18n-audit.mjs reports 100% coverage, the lane is deadlocked: it cannot commit the stamp file (outside paths causes lane-scope failure) yet the BR3 pre-push gate requires the audit to pass. BR0 only checks that main has no existing drift; it does not address the case where a new namespace has no prior stamp on main.

- `exafyltd/vitana-v1:.github/workflows/I18N-PROPAGATE.yml:29` — on:
  pull_request:
    paths:
      - 'src/i18n/de/**'

Suggestion: Run i18n-stamp-source.mjs on a scratch branch that adds only de/tenantBrand.json plus the 10 peer locale files and observe whether a new file appears in i18n-source-stamps/. If yes, either add that specific stamp path to the lane's paths, or confirm and document that the audit tool treats a missing stamp for a new namespace as coverage=100 (no prior source to compare against).

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
