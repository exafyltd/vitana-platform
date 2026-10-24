# Sparring round 3 — escalated

Session: `c351f749-3076-4fba-87b0-25aba2df8c15` · plan hash `253a715b903a2e4c945dd544eaa187122e50e75a26b9e687554bf75fec8fad75`

## Summary

I verified the central premises against the pinned SHA. Most hold: gen-tokens.mjs substituteVars (lines 98-103) only matches `var(--x)` with no fallback form, so the native-breaks premise in §3 is correct; SEMANTIC_KEYS (contract.ts:75-76) includes primary/ring; index.css:24/138 honor the `--primary` vs `--brand-accent` distinction (dark navy vs pink), confirming the fallback-chain rejection; safeHex is `#rrggbb`-only (tenant-registry.ts:115-117); ResolvedTenant exposes brandAccent/brandFg (386-378/405-417); AuthGuard literals are at 267/271 and AuthGuardProps is only children/allowGuest (13-22); CommerceJoin literals at 142/149/176; readStoredTenantSlug returns any stored canonical value (61-76); AppHooksInitializer is at App.tsx:469 and rendered at 772. The revised plan addresses R1-F3 (signup guard), R2-F1 (lane paths enumerated), and R2-F2 (AuthGuard call site). I raise one new major finding on the theme-tokens `tenantThemeVars` spec collapsing `--primary` and `--ring` onto a single accent value, and one minor on the effect-cleanup spec being under-specified relative to the existing effect that has no cleanup.

## Findings

### R3-F1 [major]

tenantThemeVars(tenant) is specified to derive BOTH --primary and --ring from the single brandAccent value, but the stylesheet defines --primary and --ring as DIFFERENT colors (light: --primary 222.2 47.4% 11.2% at index.css:24 vs --ring 222.2 84% 4.9% at :41; dark: --primary 210 40% 98% at :269 vs --ring 212.7 26.8% 83.9% at :286). Collapsing both onto one accent color silently distorts every ring/outline/focus-ring element of a non-Maxina tenant, and there is no brandRing/brandPrimary field in ResolvedTenant or TenantBrand to supply distinct values (tenant-registry.ts:25-32, 105-109 only carry accent/bg/fg). The plan's 'Scheme-neutral variables only' note does not address that ring and primary are distinct hues even within a scheme.

- `exafyltd/vitana-v1:src/index.css:24` — --primary: 222.2 47.4% 11.2%; ... --ring: 222.2 84% 4.9%;
- `exafyltd/vitana-v1:src/lib/tenant-registry.ts:105` — brandAccent?: string; brandBg?: string; brandFg?: string;

Suggestion: Specify ring explicitly rather than aliasing it to accent: either derive --ring from the foreground (brandFg) like --primary-foreground, or add a conservative mapping (e.g. leave --ring untouched for non-Maxina tenants, or map --ring to the same accent but at a fixed reduced lightness). Document and unit-test the exact expected triplet for each overridden variable so the acme test asserts distinct primary vs ring values, not a copy.

### R3-F2 [minor]

The plan states the theme effect's cleanup 'runs removeProperty on exactly those keys' so switching back to Maxina restores the stylesheet values, but the existing effect at useTenant.tsx:124-133 writes --brand-* with NO cleanup and no removeProperty, and its dependency array is [tenant]. The plan only says 'setProperty the tenantThemeVars after them' and 'update the comment' — it does not specify whether the existing --brand-* writes also gain cleanup, how the keys-to-remove list is derived, or what happens on a tenant whose brandAccent is invalid (tenantThemeVars returns {}, leaving any prior inline --primary set from the previous tenant in place). Without an explicit cleanup spec, the 'leak across tenant switches' risk (listed in Risks) is only mitigated, not closed.

- `exafyltd/vitana-v1:src/hooks/useTenant.tsx:123` — useEffect(() => { if (!tenant) return; const root = document.documentElement; const vars = [["--brand-accent", safeHex(tenant.brandAccent)], ...]; for (const [name, value] of vars) if (value) root.style.setProperty(name, value); }, [tenant]);

Suggestion: Specify the cleanup exactly: the effect returns a function that removeProperty on the union of [--primary, --ring, --primary-foreground] (and the existing --brand-* set for consistency), and runs before the next setProperty on every tenant change. Add a Vitest case: acme -> tenant-without-brandAccent clears inline --primary/--ring, matching the C2 golden and the 'acme -> Maxina clears it' test already listed.

## Acknowledgements of earlier responses

- R1-F3: acknowledged — The revised plan addresses this: useActiveTenantSlug() never reads localStorage (returns useTenant().tenant?.slug ?? 'maxina'), and BR5 adds an explicit test that signup data.tenant_slug is 'maxina' even when localStorage.tenant_slug='acme'.
- R2-F1: acknowledged — The revised plan now enumerates the complete paths array for both lanes, including CommerceJoin.tsx, useTenantMeta.ts, App.tsx, tenant-theme.ts, and all i18n locale files, and explains scopeCheck glob matching and the docs/validation exemption.
- R2-F2: acknowledged — BR1 now specifies the exact AuthGuard call site: retrySlug = activeTenantSlug({ tenantSlug: null, candidates: [readStoredTenantSlug('tenant_slug')], registry: currentRegistrySync() }), and :267 writes the validated retrySlug, :271 uses it. tenantSlug is documented as always null at this site.
