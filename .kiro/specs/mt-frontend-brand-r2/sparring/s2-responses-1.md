# Responses — session 2, round 1 (mt-frontend-brand-r2)

Planner: kiro seat hotmail (kiro-hotmail-202610212135-3b9f). Every vitana-v1 citation is at
`96becaed99bdb91d0a999a4f516a3f68cd6d4bc3` (the `spar_refs` pin).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The file exists, but in vitana-v1, not vitana-platform: exafyltd/vitana-v1:scripts/native/gen-tokens.mjs. Lines 97-104 are `substituteVars`, which replaces only `var(--x)` via /var\\((--[\\w-]+)\\)/g, with no fallback form. Lines 8-11 name the sources (`src/index.css` :root/.dark, `tailwind.config.ts`), and line 19 documents `--check` ('fail on any difference (NATIVE-CI)'). packages/tokens/src/contract.ts:73-79 (SEMANTIC_KEYS incl. primary, ring) is vitana-v1 too. The plan cited these without a repo prefix. plan.md now writes every vitana-v1 path as `vitana-v1/<full path>` and lists gen-tokens.mjs and packages/tokens under the vitana-v1 evidence base. The test step `node scripts/native/gen-tokens.mjs --check` runs in the vitana-v1 checkout and stays."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The file is exafyltd/vitana-v1:src/components/AuthGuard.tsx (no src/pages/AuthGuard.tsx exists). Line 74 has `readStoredTenantSlug('tenant_slug')`, and lines 267 and 271 have `|| 'maxina'`. The lane's paths already carry the correct path: lanes/brand-surface-r2.md front matter `- src/components/AuthGuard.tsx`, mirrored in tasks.md 'Allowed paths'. So Lane scope is not at risk, and the lane file is unchanged (a _plan commit may not edit an existing lane file, queue.mjs:585-587). The ambiguity was the bare file name in plan.md. plan.md, design.md and tasks.md now use full vitana-v1 paths for every file: AuthGuard, RedeemVoucher (src/pages/), RedemptionLanding (src/components/voucher/), store-links (src/lib/), MaxinaPortal (src/pages/portals/)."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified, and the risk is real: TenantProvider resolves a tenant only when `user` is set (vitana-v1/src/hooks/useTenant.tsx:53-54), so on an anonymous /commerce/join signup the active tenant is null, and the old fallback chain would have fallen through to raw localStorage (retired-tenants.ts:61-76 returns any stored canonical slug). Change: `useActiveTenantSlug()` is now `useTenant().tenant?.slug ?? 'maxina'`, with no localStorage step. CommerceJoin.tsx:142,149,176 use it, so an anonymous signup posts 'maxina' exactly as today, and a signed-in session on a resolved tenant posts that tenant. B1 is kept: it is requirement R2.1 of the converged plan, and the explicit-default intent of the comment at CommerceJoin.tsx:9-12 is kept in that `?? 'maxina'`. The stored slug is used only by AuthGuard's OAuth retry (B2, AuthGuard.tsx:267,271), and only if the registry lists it (findBySlug, the same guard as useTenant.tsx:62). It is never used for signUp metadata. New BR5 assertions: localStorage tenant_slug='acme' with no active tenant → signUp options.data.tenant_slug === 'maxina'; mocked active tenant acme → 'acme'; AuthGuard retry with an unlisted stored slug → 'maxina'."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "rejected",
    "rationale": "There is no deadlock: a never-stamped key is not drift. In vitana-v1/scripts/i18n-stamp-source.mjs --check, a key absent from the stamp file goes to `unstamped` (:289). Only a stamp mismatch adds to `totalDrift` (:293), and the script exits 1 only when `CHECK && totalDrift > 0` (:335-342). So `i18n-check.yml:107` (`--check-all`) stays green with new tenantBrand keys unstamped. I18N-PROPAGATE's drift COUNT (`I18N-PROPAGATE.yml:86-88`) greps the '[stamp] xx: N key(s) whose … source changed' line, i.e. drifted keys only, and its MISSING term comes from i18n:audit coverage (:108-112). Shipping all 11 locales keeps both at 0, so `pivot` (:120-122) and `fanout` are skipped and nothing writes i18n-source-stamps/**. That folder stays out of paths on purpose (a bot write must be a visible Lane-scope error). plan.md BR3 now states that unstamped is expected and is not drift."
  }
]
```
