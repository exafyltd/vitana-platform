# Tasks — mt-frontend-brand-r2 (Amendment 1 of mt-frontend-brand)

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. Design: `design.md`.
VTID: allocated by PLAN-SPAR after approval (one per lane). Both lanes: repo vitana-v1, seat exafyltd, reviewer agent
`vitana-lane-reviewer`. `docs/validation/<vtid>/**` is implicitly each lane's own.

<!-- lane: brand-surface-r2 -->
## brand-surface-r2 — member-facing brand constants tenant-driven, Lane-scope clean (repo vitana-v1)

Allowed paths:
- `src/pages/CommerceJoin.tsx`
- `src/pages/CommerceJoin.oauth-first.test.ts`
- `src/pages/CommerceJoin.routing.test.ts`
- `src/components/AuthGuard.tsx`
- `src/pages/RedeemVoucher.tsx`
- `src/components/voucher/RedemptionLanding.tsx`
- `src/lib/store-links.ts`
- `src/lib/store-links.test.ts`
- `src/hooks/useTenantMeta.ts`
- `src/hooks/useTenantMeta.test.ts`
- `src/App.tsx`
- `src/i18n/{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}/tenantBrand.json` (11 explicit paths in the lane file)
- `docs/SCREEN_INVENTORY.md`
- `tests/e2e/staging/vtid-*-brand-surface.staging.spec.ts`

- [ ] BR0 Precondition on the lane base, before any commit: `node scripts/i18n-stamp-source.mjs --check-all` reports 0
      changed and `node scripts/i18n-audit.mjs` shows every ga locale at 100.0%. If not, main itself would trigger
      I18N-PROPAGATE (`I18N-PROPAGATE.yml:108-122`): stop, log it, set `next_actor: claude` and push nothing.
- [ ] BR1 Fresh branch `kiro/mt-frontend-brand-r2/brand-surface-r2` from V1 main. Cherry-pick the code of `e31230ac6`
      and `7a8b2ab74` only, never the bot commits `e7e62ca89`, `3c56f18e1`, `14cdc2adf`. A pick that conflicts with
      main is re-implemented to plan.md's spec instead (`useTenantMeta.ts`/`useActiveTenantSlug()` do not exist at
      vitana-v1 `96becaed9`). Every commit carries `Collab-Lane: mt-frontend-brand-r2/brand-surface-r2`.
- [ ] BR2 i18n: DE first (du-form) `tenantBrand.json` (`goToPortal: "Zu {brand}"`, `logoAlt: "Logo von {brand}"`), EN
      mirror, then the 9 other locales (by hand or `node scripts/translate-keys.mjs --provider=deepseek --locale=<code>`
      restricted to `tenantBrand.json`; discard any other file it writes). `{brand}` in every value; `ar` RTL text.
      `npm run i18n:inventory`.
- [ ] BR3 Pre-push gate, in order: `node scripts/i18n-stamp-source.mjs --check-all` 0 changed for every locale;
      `node scripts/i18n-audit.mjs` 100.0% for the 10 non-DE locales; `git diff --name-only origin/main...HEAD` ⊆ paths.
      After each push confirm I18N-PROPAGATE skipped `pivot`/`collect` (no new `github-actions[bot]` commit); if one
      appears, stop and log it — never re-push to force it.
- [ ] BR4 B1: `CommerceJoin.tsx` `const tenantSlug = useActiveTenantSlug()` used at `:142,149,176`; header comment
      `:9-12` says "the active tenant's slug, `maxina` when there is none (every anonymous visitor today)".
      `oauth-first.test.ts:29` → `queryParams: { tenant_slug: tenantSlug }`, `routing.test.ts:55` →
      `tenant_slug: tenantSlug`; keep the wrong-tenant comment (reworded); assert `tenantSlug` comes from
      `useActiveTenantSlug()` and that the hook is `useTenant().tenant?.slug ?? 'maxina'` with no storage read.
- [ ] BR5 B7: signup unit test (mocked `supabase.auth.signUp`, no network) asserts `options.data.tenant_slug`:
      - `acme` in a TenantProvider mock with an active `acme` tenant;
      - `maxina` without a tenant;
      - `maxina` without a tenant but with `localStorage.tenant_slug = 'acme'` (`useActiveTenantSlug()` never reads
        storage).

      AuthGuard retry-slug test for `activeTenantSlug({ tenantSlug: null, candidates: [stored], registry })`: a
      registry-listed stored slug is returned, an unlisted one gives `maxina` (the literals at
      `src/components/AuthGuard.tsx:267,271`; call site per plan.md: `retrySlug` computed once with
      `tenantSlug: null`, `registry: currentRegistrySync()`, written at `:267` and used at `:271`). A test that `App.tsx` calls `useTenantMeta()` inside
      `AppHooksInitializer` (`App.tsx:469`).
- [ ] BR6 Staging spec `tests/e2e/staging/vtid-<vtid>-brand-surface.staging.spec.ts` (read-only, preview host only,
      non-GET guard): `/commerce/join` + voucher landing show Maxina title/favicon and `/maxina` portal link;
      `docs/validation/<vtid>/staging-tests.json` lists it plus the Vitest refs.
Acceptance: the four targeted Vitest files green and the signup assertion red on V1 main; full `npx vitest run` green
except failures already red on main (listed in `commands.log`, e.g. `ConversationView.deeplink-scroll.vtid-05201`);
CI Lane scope green on the final head with no `github-actions[bot]` commit; `i18n-check.yml` stamps + register green;
ESLint `i18n/*` + `design/*` clean on changed files; RTL unaffected; `src/App.tsx` diff = one import + one
`useTenantMeta();` (pinned by the BR5 mount test).

<!-- lane: theme-tokens-r2 -->
## theme-tokens-r2 — tenant theme renders via runtime HSL overrides (repo vitana-v1)

Allowed paths:
- `src/lib/tenant-theme.ts`
- `src/lib/tenant-theme.test.ts`
- `src/hooks/useTenant.tsx`
- `src/hooks/useTenant.theme.test.tsx`
- `tests/e2e/staging/vtid-*-theme-tokens.staging.spec.ts`

- [ ] TT1 `tenant-theme.ts` + test: `hexToHslTriplet` (`#FF7BAC` → `"339.4 100% 74.1%"`-style, `#fff`, invalid → null);
      `tenantThemeVars` → `{}` for Maxina, null and no-accent tenants; `--primary`, `--ring`, `--primary-foreground`
      for `acme`.
- [ ] TT2 `useTenant.tsx` effect: keep the `--brand-*` writes; apply `tenantThemeVars` after them; `removeProperty`
      exactly those keys on cleanup / tenant change; update the "nothing consumes them yet — C2" comment
      (`useTenant.tsx:123`). Test pattern: `src/hooks/useTenant.registry.test.tsx`.
      `useTenant.theme.test.tsx` (jsdom, mocked registry + Supabase, no network): Maxina inline `--primary` is `''`;
      `acme` gets the triplet; acme → Maxina clears it; `--brand-*` writes unchanged.
- [ ] TT3 `node scripts/native/gen-tokens.mjs --check` exit 0; byte identity (below); full `npx vitest run`.
- [ ] TT4 Staging spec `tests/e2e/staging/vtid-<vtid>-theme-tokens.staging.spec.ts` (read-only, preview host only,
      non-GET guard): on `/maxina` computed `--primary` is `222.2 47.4% 11.2%` (light) / `210 40% 98%` (`.dark`) and
      inline `--primary` is `''`; `docs/validation/<vtid>/staging-tests.json` lists it (`spec`) plus the Vitest refs
      (`existing`, reason: no second tenant on staging, D13).
Acceptance: "acme sets --primary" red on V1 main, green on head; Maxina case green on both;
`gen-tokens.mjs --check` exit 0 and `git status packages/` clean;
`git diff --exit-code origin/main -- src/index.css tailwind.config.ts packages/`; `npm run build` on main and head with
equal sha256 of `dist/assets/*.css` (both hashes in `commands.log`); C2 golden green and unchanged; ESLint `design/*` +
`i18n/*` clean on new files. Never edit `src/index.css`, `tailwind.config.ts`, `scripts/native/gen-tokens.mjs` or
`packages/**`.

## Escalation carry-over (session 2, round 3)

Sparring session `c351f749-3076-4fba-87b0-25aba2df8c15` escalated at round 3 (`sparring/s2-round-3.md`, plan hash
`253a715b903a2e4c945dd544eaa187122e50e75a26b9e687554bf75fec8fad75`); MAX_SESSIONS is 2, so there is no session 3.
`plan.md` is unchanged. The two open findings below are binding acceptance criteria for lane `theme-tokens-r2` and
override TT1/TT2 where they conflict. Both apply only if the owner approves the plan as escalated.

- [ ] **R3-F1** [major] (`--primary`/`--ring` collapsed onto one accent): `tenantThemeVars` leaves `--ring` untouched
      for non-Maxina tenants. It sets only `--primary` and `--primary-foreground`, so `--ring` keeps the stylesheet
      value (`src/index.css:41` light, `:286` dark). The `acme` test asserts that computed `--primary` and `--ring`
      are distinct values (primary = accent triplet, ring = stylesheet value, no inline `--ring`), not a copy.
- [ ] **R3-F2** [minor] (theme effect cleanup under-specified): the `useTenant.tsx` theme effect returns a cleanup
      that calls `removeProperty` on the union of the `--brand-*` keys (`--brand-accent`, `--brand-bg`, `--brand-fg`)
      plus `--primary`, `--primary-foreground` and `--ring`. It runs before every tenant change (React effect cleanup,
      deps `[tenant]`) and on unmount. Vitest cases in `useTenant.theme.test.tsx`: acme → Maxina clears the inline
      vars, and acme → tenant-without-brandAccent clears the inline vars (inline `--primary`, `--primary-foreground`,
      `--ring` all `''` afterwards).
