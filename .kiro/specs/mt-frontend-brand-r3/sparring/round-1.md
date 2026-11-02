# Sparring round 1 — in_progress

Session: `69b2c563-fc9f-4a20-ada8-b175c5d5c491` · plan hash `c3ac33da78b019aec8d376f7d47a15b1faf11db3c99228af8c144f7b18587400`

## Summary

The plan is thorough and well-reasoned. I verified 12+ premises against the pinned code and all held. The line references for useTenant.tsx, AuthGuard.tsx, index.css, MaxinaPortal.tsx, tailwind.config.ts, tenant-registry.ts, RedemptionLanding.tsx, RedeemVoucher.tsx, CommerceJoin.tsx, App.tsx, retired-tenants.ts, store-links.ts, and gen-tokens.mjs are all accurate. The proposed approach of writing HSL triplets directly to --primary (rather than a CSS fallback chain) correctly avoids the hex-in-hsl and gen-tokens breakage. I found one minor internal inconsistency in the test description and one minor validation surface divergence. No blockers or major issues.

## Findings

### R1-F1 [minor]

The test description for theme-tokens-r3 says '3 vars for acme' but the authoritative R3-F1 acceptance criteria and the functional spec both state that tenantThemeVars returns at most 2 keys (--primary from brandAccent, --primary-foreground from brandFg). --background/--foreground/--accent are explicitly out of scope, and --ring is explicitly excluded per R3-F1. This is an internal inconsistency that could confuse the executor.

- `exafyltd/vitana-v1:src/hooks/useTenant.tsx:123` — // Apply tenant CSS variables (validated hex only; nothing consumes them yet — C2).
    useEffect(() => {
      if (!tenant) return;
      const root = document.documentElement;
      const vars: Array<[string, string | undefined]> = [
        ["--brand-accent", safeHex(tenant.brandAccent)],
        ["--brand-bg", safeHex(tenant.brandBg)],
        ["--brand-fg", safeHex(tenant.brandFg)],
      ];
      for (const [name, value] of vars) if (value) root.style.setProperty(name, value);
    }, [tenant]);
- `exafyltd/vitana-v1:src/lib/tenant-registry.ts:107` —     brandAccent?: string;
    brandBg?: string;
    brandFg?: string;

Suggestion: Correct '3 vars for acme' to '2 vars' (or 'up to 2 vars') in the tenant-theme.test.ts description to match the R3-F1 acceptance criteria which assert keys are exactly ['--primary', '--primary-foreground'].

### R1-F2 [minor]

The new hexToHslTriplet function is specified to accept '#rgb' (3-digit shorthand) in addition to '#rrggbb', but the existing safeHex validator (tenant-registry.ts:115-116) only accepts '#rrggbb' (exactly 6 hex digits after #). Since brandAccent/brandFg values in the database are validated through safeHex in the existing --brand-* write path, they are guaranteed to be #rrggbb. Accepting #rgb in hexToHslTriplet creates a wider validation surface for the new --primary write path than the existing --brand-* path, which could cause subtle divergence if a 3-digit hex value ever enters the database (tenantThemeVars would set --primary but useTenant's existing code would skip --brand-accent for the same tenant).

- `exafyltd/vitana-v1:src/lib/tenant-registry.ts:114` — /** `#rrggbb` or undefined — a database value can never inject CSS. */
export function safeHex(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}
- `exafyltd/vitana-v1:src/hooks/useTenant.tsx:127` —       const vars: Array<[string, string | undefined]> = [
        ["--brand-accent", safeHex(tenant.brandAccent)],
        ["--brand-bg", safeHex(tenant.brandBg)],
        ["--brand-fg", safeHex(tenant.brandFg)],
      ];
      for (const [name, value] of vars) if (value) root.style.setProperty(name, value);

Suggestion: Match safeHex's strictness: either restrict hexToHslTriplet to only accept #rrggbb (6-digit), or explicitly document and test that #rgb acceptance is intentional defence-in-depth beyond safeHex, with a test asserting the divergence case (3-digit hex sets --primary but not --brand-accent).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
