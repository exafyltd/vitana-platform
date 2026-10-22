---
change_class: standard
---
# plan(mt-frontend-brand-r2): amend brand-surface paths and theme-tokens approach

<!-- plan:begin -->
## Amendment 1: brand-surface paths and theme-tokens approach
This spec is Amendment 1 of the converged plan `mt-frontend-brand` (policy-approved 2026-10-19, VTID-05241..05246).
It re-plans two of its six lanes and supersedes them:
- `mt-frontend-brand/brand-surface` (VTID-05242) → `mt-frontend-brand-r2/brand-surface-r2`
- `mt-frontend-brand/theme-tokens` (VTID-05246) → `mt-frontend-brand-r2/theme-tokens-r2`

Why a new slug instead of editing `mt-frontend-brand` (verified on vitana-platform `origin/main`):
- A converged sparring session is never re-sparred: `scripts/collab/plan-spar.mjs:296-348` returns `nothing_to_do` for a
  converged session whatever the new plan text; new lane ids under the old slug would get VTIDs through
  `allocate_retry` (`:336-347`) with no sparring of the changed text (against rule 51). A new slug gets a fresh
  session (action `create`), its own policy approval and two CI-allocated VTIDs. Precedent: `kaf-fallback-env`.
- Lane `paths` are frozen for Kiro: `queue.mjs:678-687` rejects a `paths` change in a lane PR, and a `_plan` commit
  "may create a lane file, never edit one" (`queue.mjs:585-587`).

The four other lanes (`adminfetch-header` VTID-05241, `cors-config` VTID-05243, `email-brand-code` VTID-05244,
`email-brand-db` VTID-05245) are unchanged and stay in `mt-frontend-brand`. The two old lanes stay parked; after this
plan converges the PM / exceptions seat parks them as superseded (seat exafyltd lane-state commits) and terminalizes
VTID-05242 and VTID-05246 `cancelled`. Kiro never writes the ledger. `vitana-v1#1485` is closed unmerged, its branch
kept; its non-bot code is reused (BR1).

## Problem
Premises pinned to vitana-v1 `origin/main` @ `e9258f980`; PR evidence from `exafyltd/vitana-v1#1485` @ `14cdc2adf`.

1. **brand-surface cannot pass Lane scope.** V1 `PR-GATE.yml:297-326` runs `queue.mjs scope-check`, which diffs
   `base...head` over all commits (`queue.mjs:689`) and exempts only the spec folder and `docs/validation/<vtid>/`
   (`:690`); there is no bot exemption. The lane added a new `tenantBrand` namespace in `de`+`en` only, so
   `I18N-PROPAGATE.yml` (`:33-35`, `:114`, `:122`, `:158`, `:261`) pushed bot commits `e7e62ca89`, `3c56f18e1`,
   `14cdc2adf` into the PR: `i18n-source-stamps/*.json`, `src/i18n/en/screens.json`, 9 locale `tenantBrand.json`, plus
   unrelated `admin.json`/`inbox.json`/`notificationControls.json`. All outside the lane's paths.
   Lanes that pass ship the new namespace in all 11 locales themselves (`vitana-v1#1474`, VTID-05320), so propagation
   has nothing to do. V1 main today: `i18n-stamp-source --check-all` 0 drift, `i18n-audit` 100.0% in every locale.
2. **B1 is blocked by tests outside paths.** `src/pages/CommerceJoin.oauth-first.test.ts:29` and
   `src/pages/CommerceJoin.routing.test.ts:53-55` pin `tenant_slug: 'maxina'`; `CommerceJoin.tsx:9-12,142,149,176` hold
   the literal. The review of `7a8b2ab7` (`review-round-1.json`) has 4 blocking findings: the two bot files, B1 missing,
   B7 incomplete (signup assertion, AuthGuard retry slug).
3. **theme-tokens' approach is wrong.** `src/index.css:138-140` (`:root`) and `:385-387` (`.dark`) already declare
   `--brand-accent: 339 89% 49%` (pink), so `--primary: var(--brand-accent, …)` would render pink for Maxina; the plan's
   "fallback == compiled value" premise is false. `useTenant.tsx:123-133` and `MaxinaPortal.tsx:234-236` write **hex**
   values, and `tailwind.config.ts:65` emits `hsl(var(--primary))`, so a hex in that chain is an invalid colour.
   `scripts/native/gen-tokens.mjs:97-103` resolves only `var(--x)` (no fallback form), so `--primary` would drop out of
   `packages/tokens` (`contract.ts:73-79` `SEMANTIC_KEYS`), breaking native.

## Fix
**Lane `brand-surface-r2` (kiro, seat exafyltd, vitana-v1).** Same scope as `brand-surface` (B1–B7 of the original
plan), rebuilt so Lane scope can pass:
- Fresh branch from V1 main; cherry-pick only the code of `e31230ac6` and `7a8b2ab74`, never a `github-actions[bot]`
  commit; re-trailer with `Collab-Lane: mt-frontend-brand-r2/brand-surface-r2`.
- Ship `tenantBrand.json` in all 11 active locales (DE first, du-form; `{brand}` kept; `ar` RTL text) so
  I18N-PROPAGATE has no drift and pushes nothing. `screens.json` and `i18n-source-stamps/**` are deliberately not in
  paths, so any bot touch stays visible as a Lane-scope error.
- B1: `CommerceJoin.tsx` uses `useActiveTenantSlug()` at `:142,149,176`; both CommerceJoin tests are now in paths and
  assert the active slug (`maxina` on every host serving the page today, so behaviour is unchanged).
- B7: signup assertion (active slug for a mocked `acme` tenant, `maxina` without one) and an AuthGuard retry-slug
  unit test. Mount/AuthGuard/voucher are already asserted at `useTenantMeta.test.ts:177-201`.
- Pre-push gate: stamp drift 0 for every locale, audit 100.0% for the 10 non-DE locales, changed files ⊆ paths.

**Lane `theme-tokens-r2` (kiro, seat exafyltd, vitana-v1).** Runtime HSL overrides for non-default tenants only; no CSS
change:
- New `src/lib/tenant-theme.ts`: `hexToHslTriplet(hex)` (`#rgb`/`#rrggbb` → `"H S% L%"`, one decimal; invalid → null)
  and `tenantThemeVars(tenant)` → `{}` for a missing tenant, slug `maxina` or no valid `brandAccent`; otherwise
  `--primary` and `--ring` from `brandAccent`, `--primary-foreground` from a valid `brandFg`. Scheme-neutral variables
  only (`--background`/`--foreground`/`--accent` not overridden — conservative, recorded).
- `useTenant.tsx:123-133`: keep the `--brand-*` writes unchanged; after them `setProperty` the `tenantThemeVars`; on
  cleanup and tenant change `removeProperty` exactly those, so switching back to Maxina restores the stylesheet.
- No change to `src/index.css`, `tailwind.config.ts`, `scripts/native/gen-tokens.mjs`, `packages/**` or the C2 golden
  (`tenant-registry.maxina-golden.test.tsx:172-187` stays true). Maxina never gets an inline `--primary`, built CSS is
  byte-identical, native tokens show no drift.
- Rejected: CSS fallback chain (renders pink, invalid hex, breaks native); teaching gen-tokens `var(x, fallback)`
  (still hex at runtime, larger blast radius); switching `--brand-*` writes to HSL (MaxinaPortal's `#FF7BAC` would start
  rendering on Maxina).

The two lanes' path sets are disjoint from each other and from the four live `mt-frontend-brand` lanes.

## Migrations
None.

## Tests
- `brand-surface-r2`: `npx vitest run src/hooks/useTenantMeta.test.ts src/lib/store-links.test.ts
  src/pages/CommerceJoin.oauth-first.test.ts src/pages/CommerceJoin.routing.test.ts` green; the new signup assertion
  fails on V1 main (literal `maxina` for `acme`). Full `npx vitest run` green except failures already red on main,
  listed in `commands.log`. ESLint `i18n/*` + `design/*` clean. CI Lane scope green, no `github-actions[bot]` commit,
  `i18n-check.yml` stamps/register green. `src/App.tsx` diff = one import + one `useTenantMeta();`.
- `theme-tokens-r2`: `tenant-theme.test.ts` (triplet conversion, `{}` for Maxina/null/no accent, 3 vars for `acme`);
  `useTenant.theme.test.tsx` (jsdom, mocked registry/Supabase): Maxina leaves inline `--primary` empty, `acme` gets the
  triplet (fails on main), acme → Maxina clears it, `--brand-*` writes unchanged. `gen-tokens.mjs --check` exit 0;
  `git diff --exit-code origin/main -- src/index.css tailwind.config.ts packages/`; `dist/assets/*.css` sha256 equal on
  main and head; C2 golden green unchanged.

## Staging verification
Read-only (rule 48), `https://preview-aws.vitanaland.com` only; the spec throws on any other host; a network guard
aborts every non-GET to the gateway and Supabase REST except `auth/v1/token?grant_type=password`; signs in as the test
user via the REST snippet.
- `tests/e2e/staging/vtid-<vtid>-brand-surface.staging.spec.ts`: `/commerce/join` and the voucher landing show Maxina's
  title/favicon and a `/maxina` portal link.
- `tests/e2e/staging/vtid-<vtid>-theme-tokens.staging.spec.ts`: on `/maxina`, computed `--primary` is
  `222.2 47.4% 11.2%` (light) / `210 40% 98%` (`.dark`) and inline `--primary` is empty. No non-Maxina tenant exists in
  production (D13), so the tenant override is proven by Vitest only (`staging-tests.json` lists it as `existing`).
Each lane's record is `docs/validation/<its new VTID>/staging-tests.json`.

## Rollout
No flag. Maxina is byte-identical by construction (brand-surface: the active slug is `maxina` on every serving host;
theme-tokens: no CSS change and a slug guard). Tenant values only render for a non-Maxina tenant, which cannot exist in
production until an owner-approved provisioning step (D13).

## Risks
- I18N-PROPAGATE still pushes into the brand-surface PR. Mitigation: pre-push drift/audit gate; after each push confirm
  no bot commit; if one appears, stop and log, never re-push to force it.
- Inline overrides leaking across tenant switches. Mitigation: remove exactly the set variables; unit test acme → Maxina.
- Superseded lanes left open. Mitigation: the PM / exceptions seat parks both and cancels VTID-05242/05246 after
  convergence; recorded in `handoff.md`.

## Out of scope
Everything else of `mt-frontend-brand` (its four other lanes stay there). Overriding `--background`/`--foreground`/
`--accent` per tenant (a later lane). Native brand (WS9).

## Depends on
Done: VTID-05151 (registry/portal/`useTenant`). The code already on `vitana-v1#1485` (reused, not merged).

## Owner decisions
No new owner decision. D13 (no synthetic tenant in prod); owner instruction 2026-10-21/22 (full automation to verified
staging).
<!-- plan:end -->
