---
change_class: standard
---
# plan(mt-frontend-brand-r3): amend brand-surface paths and theme-tokens approach

<!-- plan:begin -->
## Re-plan answers (session `c351f749` round 3)
Re-plan of `mt-frontend-brand-r2` (Amendment 1, branch `kiro/mt-frontend-brand/plan-amend-1`; PLAN-SPAR session `c351f749`
escalated at the round cap) under the new slug `mt-frontend-brand-r3`. Premises were re-verified on vitana-v1
`origin/main` `58c76c9566` and platform `62990ce285` on 2026-11-01, and the companion pin moves to vitana-v1 `58c76c9566`.
- **R3-F1** (`--ring` collapsed onto the accent): accepted. `tenantThemeVars(tenant)` returns only `--primary` (from
  `brandAccent`) and `--primary-foreground` (from `brandFg` when valid). It never returns `--ring`, so every
  ring, outline and focus ring keeps the stylesheet value (`index.css:41` light, `:286` dark). A per-tenant ring
  colour needs a new brand field and is out of scope.
  - Tests in `tenant-theme.test.ts`: for acme (`brandAccent '#ff0000'`) the keys are exactly
    `['--primary', '--primary-foreground']` and `--primary` is `0 100% 50%`.
  - In `useTenant.theme.test.tsx`: `getPropertyValue('--ring') === ''` after acme applies.
  - Both are red on `main`, where `--primary` is never set inline.
- **R3-F2** (the cleanup was underspecified): accepted.
  - The effect computes `const vars = tenantThemeVars(tenant)` and `const keys = Object.keys(vars)`, sets them, and
    returns `() => keys.forEach((k) => root.style.removeProperty(k))`. React runs the previous run's cleanup before
    the next effect, so each tenant change removes exactly the keys the previous tenant set.
  - A tenant without a valid accent gets `{}`, so nothing is set, and the previous keys are already removed.
  - The existing `--brand-*` writes (`useTenant.tsx:124-133`) stay unchanged and get no cleanup. `MaxinaPortal.tsx:232-237`
    also writes those without cleanup, and a cleanup here would change that page's behaviour outside this lane.
  - Test: rerender acme → `{ slug: 'beta' }` (no `brandAccent`) → Maxina. `--primary` is set in the first state and
    `''` in each later state. The first assertion is red on `main`.
- **Line corrections:**
  - `RedemptionLanding.tsx` refs are now `:55,59` (`/maxina?redirectTo=`) and `:69-70` (logo and alt).
  - `RedeemVoucher.tsx` refs are now `:91,135,164,192`.
  - `queue.mjs`: `scopeCheck` `:912`, `commitsInRange` `:669`, the `_plan` "may create a lane file, never edit one"
    rule `:863`, the spec/validation exemption `:991`, and the permission freeze `:983-985`. That freeze now also
    has a reviewed `lane_admin` route (VTID-05408). This re-plan still uses a new slug, because the original lanes'
    `paths` cannot be changed by a `_plan` commit.
  - PR #1485 (closed unmerged, branch kept) now ends at bot commit `079d409c7`, and that commit is on the never-pick
    list too.
- **Lanes on today's rules:** both lanes are `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`,
  `next_actor: kiro`. A real i18n drift on `main` (BR0) parks the lane with `next_actor: owner`. It is never handed
  to Claude, because Claude Code is retired.
- **Original lanes:** `brand-surface` (VTID-05242, parked) and `theme-tokens` (VTID-05246) in `mt-frontend-brand`
  are superseded by this spec's two lanes. Recording that supersession on the original lane files is the
  `mt-frontend-brand` driver's job under its own `_plan` claim, not this spec's.

## Amendment 1: brand-surface paths and theme-tokens approach
This spec is Amendment 1 of the converged plan `mt-frontend-brand` (policy-approved 2026-10-19, VTID-05241..05246).
It re-plans two of its six lanes and supersedes them:
- `mt-frontend-brand/brand-surface` (VTID-05242) → `mt-frontend-brand-r3/brand-surface-r3`
- `mt-frontend-brand/theme-tokens` (VTID-05246) → `mt-frontend-brand-r3/theme-tokens-r3`

The four other lanes (`adminfetch-header` VTID-05241, `cors-config` VTID-05243, `email-brand-code` VTID-05244,
`email-brand-db` VTID-05245) are unchanged and stay in `mt-frontend-brand`. After this plan converges the PM /
exceptions seat parks the two old lanes as superseded and terminalizes VTID-05242 and VTID-05246 `cancelled`; Kiro
never writes the ledger. `vitana-v1#1485` is closed unmerged with its branch kept; its non-bot code is reused (BR1).

## Evidence base (what the partner can read)
- **vitana-v1 at `58c76c9566dc035fe506a304e42c8700a110bcb5`** (its `origin/main` at this re-plan, 2026-11-01), declared in
  `handoff.md` `spar_refs`. Every `vitana-v1` `file:line` below is at that SHA unless marked "PR evidence". Files
  named without a repo are vitana-v1 files. That includes `scripts/native/gen-tokens.mjs`, `packages/tokens/**`,
  `scripts/i18n-*.mjs` and `.github/workflows/{PR-GATE,I18N-PROPAGATE,i18n-check}.yml`; only `scripts/collab/**` is
  vitana-platform. Full vitana-v1 paths of the files the lanes touch:
  - `src/components/AuthGuard.tsx`
  - `src/pages/RedeemVoucher.tsx`
  - `src/components/voucher/RedemptionLanding.tsx`
  - `src/lib/store-links.ts`
  - `src/pages/portals/MaxinaPortal.tsx`
  - `src/hooks/useTenant.tsx`
  - `src/lib/tenant-registry.ts`
  - `src/lib/retired-tenants.ts`
- **vitana-platform at this PR's base** for `scripts/collab/**`. vitana-v1's Lane-scope job fetches
  `scripts/collab/queue.mjs` from vitana-platform main (`vitana-v1/.github/workflows/PR-GATE.yml:318-326`), so the
  checker cited below is the platform copy.
- **PR evidence** (not on any readable ref): `vitana-v1#1485` @ `14cdc2adf` and its review `review-round-1.json`.
  Nothing in the Fix depends on reading it. The code it holds (`useTenantMeta.ts`, `useActiveTenantSlug()`,
  `tenantBrand.json`) does **not** exist at the pinned SHA (`git grep useTenantMeta|useActiveTenantSlug|tenantBrand`
  under `src/` has no hit). The lane introduces it, and it is specified below.

## Why a new slug instead of editing `mt-frontend-brand`
- A converged session is never re-sparred. `vitana-platform/scripts/collab/plan-spar.mjs:304-348`: create, retry and
  replan run only for a missing or escalated session (`:306-309`), and an edited converged plan falls through to
  `nothing_to_do` (`:348`). New lane ids under the old slug would get VTIDs through `allocate_retry` (`:336-347`)
  without any sparring of the changed text, which breaks rule 51. A new slug gets a fresh session, its own policy
  approval and two CI-allocated VTIDs. Precedent: `kaf-fallback-env`.
- Lane `paths` are frozen. `queue.mjs:983-985` rejects a `paths`/`executor`/`seat`/`reviewer_seat` change in a lane PR
  unless the lane is `executor: claude`. A `_plan` commit "may create a lane file, never edit one" (`queue.mjs:863`).

## Problem
1. **brand-surface cannot pass Lane scope.** V1 `PR-GATE.yml:297-326` runs `queue.mjs scope-check`.
   `scopeCheck` (`queue.mjs:912-`) diffs `base...head` over all commits (`:990`). Its only exemptions are the spec
   folder and `docs/validation/<vtid>/` (`:991`), and the trailer scan (`commitsInRange`, `:669`) has no
   author/bot exemption. `I18N-PROPAGATE.yml` triggers on any PR touching `src/i18n/de/**` (`:30-35`). A `plan` job
   counts drift plus missing keys (`:108-116`), and on non-zero drift `pivot` (`:120-122`) and the fan-out commit as
   `github-actions[bot]` into the PR branch (`:156-163`, `:259-266`, `git add src/i18n i18n-source-stamps` `:261`).
   The old lane added a `tenantBrand` namespace in `de`+`en` only. PR evidence: the bot pushed `e7e62ca89`,
   `3c56f18e1` and `14cdc2adf` (stamps, `en/screens.json`, 9 locale files and unrelated `admin.json`/`inbox.json`/
   `notificationControls.json`), all outside the lane's paths. A lane that ships every active locale of a new
   namespace in its own commits leaves the drift count at 0, so `pivot`/`fanout` are skipped (`:122`).
2. **B1 is blocked by tests outside paths.** The literal is at `src/pages/CommerceJoin.tsx:142,149,176`, and the
   header `:9-12` says "Maxina only, deliberately". Two tests pin it: `CommerceJoin.oauth-first.test.ts:29`
   (`queryParams: { tenant_slug: 'maxina' }`) and `CommerceJoin.routing.test.ts:53-55`. Neither file was in the old
   lane's paths. Other literals the lane owns (B2–B5, unchanged scope):
   - `src/components/AuthGuard.tsx:267,271` (`|| 'maxina'`)
   - `src/components/voucher/RedemptionLanding.tsx:55,59` (`/maxina?redirectTo=`) and `:69-70` (logo + alt `MAXINA`)
   - `src/pages/RedeemVoucher.tsx:91,135,164,192` (`navigate("/maxina")`)
   - `src/lib/store-links.ts:6,31`

   Anonymous visitors have no tenant: `TenantProvider` resolves one only when `user` is set
   (`src/hooks/useTenant.tsx:53-54`), and it accepts a stored slug only if the registry lists it (`:62`).
   `readStoredTenantSlug` (`src/lib/retired-tenants.ts:61-76`) returns any stored canonical value. The mount point
   `AppHooksInitializer` is at `src/App.tsx:469` and is rendered at `:772`.
3. **theme-tokens' approach is wrong.**
   - `src/index.css:137-140` (`:root`) and `:384-387` (`.dark`) already declare `--brand-accent: 339 89% 49%` (pink),
     so `--primary: var(--brand-accent, …)` would render pink for Maxina, where `--primary` is `222.2 47.4% 11.2%`
     (`:24`) / `210 40% 98%` (`:269`). The old plan's "fallback == compiled value" premise is false.
   - `src/hooks/useTenant.tsx:123-133` writes `safeHex(...)` values (hex; `safeHex` at `src/lib/tenant-registry.ts:115`),
     and `src/pages/portals/MaxinaPortal.tsx:232-237` writes `#FF7BAC`/`#FFF5F8`/`#1A1A1A`. `tailwind.config.ts:61,65-66` emit
     `hsl(var(--ring))`/`hsl(var(--primary))`, and `index.css:6` requires HSL, so a hex in that chain is an invalid
     colour.
   - vitana-v1 `scripts/native/gen-tokens.mjs:97-104` (`substituteVars`) substitutes only `var(--x)` (no fallback
     form). It reads `src/index.css` `:root`/`.dark` and `tailwind.config.ts` (`:8-11`), and `--check` fails on any
     difference (`:19`). So `--primary` would drop out of vitana-v1 `packages/tokens`
     (`packages/tokens/src/contract.ts:73-79` `SEMANTIC_KEYS` includes `primary`, `ring`), breaking native.
   - The C2 golden `src/lib/tenant-registry.maxina-golden.test.tsx:172-187` asserts that nothing consumes
     `var(--brand-*)`. An approach that never reads `var(--brand-*)` keeps it true.

## Fix
**Lane `brand-surface-r3` (kiro, seat exafyltd, vitana-v1).** Same scope as `brand-surface` (B1–B7 of the original
plan), rebuilt so Lane scope can pass:
- BR0 precondition, before the first commit: on the lane base run `node scripts/i18n-stamp-source.mjs --check-all`
  and `node scripts/i18n-audit.mjs`. If main itself has drift, or a ga locale below 100%, I18N-PROPAGATE would push into
  any `de/**` PR whatever the lane does. Stop, log it, park the lane with `next_actor: owner`, and push nothing.
- BR1 Fresh branch from V1 main. Cherry-pick only the non-bot code of `#1485` (`e31230ac6`, `7a8b2ab74`), never a
  `github-actions[bot]` commit, re-trailered `Collab-Lane: mt-frontend-brand-r3/brand-surface-r3`. If a pick
  conflicts with main, re-implement it to the spec below instead of resolving toward the PR.
- What the lane introduces (absent at the pinned SHA):
  - `src/hooks/useTenantMeta.ts` exporting two functions:
    - `useActiveTenantSlug()` returns `useTenant().tenant?.slug ?? 'maxina'`. It never reads localStorage. An
      anonymous signup (no tenant, `useTenant.tsx:53-54`) therefore posts `maxina`, exactly today's literal, and a
      session on a resolved tenant posts that tenant.
    - `activeTenantSlug({ tenantSlug, candidates, registry })` is a pure function used only by AuthGuard's OAuth retry
      (B2). Order: `tenantSlug`, else the first candidate the registry lists (`findBySlug`, the same guard as
      `useTenant.tsx:62`), else `maxina`.

    A stored slug never reaches `supabase.auth.signUp` metadata (sparring s2 R1-F3).
  - AuthGuard call site (s2 R2-F2). `AuthGuardProps` has only `children` and `allowGuest` (`AuthGuard.tsx:13-22`), so
    `tenantSlug` is always `null` here; it exists for callers that already know the slug. `AuthGuard.tsx:7` already
    imports `currentRegistrySync`/`findBySlug`. Inside the retry handler, before `:267`:
    `const retrySlug = activeTenantSlug({ tenantSlug: null, candidates: [readStoredTenantSlug('tenant_slug')], registry: currentRegistrySync() });`
    then `:267` becomes `localStorage.setItem('tenant_slug', retrySlug);` (the validated slug, not the raw stored
    value) and `:271` becomes `redirectTo: window.location.origin + '/' + retrySlug`. No other AuthGuard line changes.
  - `useTenantMeta()` sets `document.title` + favicon only (no OG, original R1-F4), mounted by one call in
    `AppHooksInitializer` (`App.tsx:469`).
- BR2 Ship `tenantBrand.json` in all 11 active locales (DE first, du-form; `{brand}` kept; `ar` RTL text) so
  I18N-PROPAGATE's drift is 0 and it pushes nothing. `screens.json` and `i18n-source-stamps/**` are deliberately not in
  paths, so any bot touch stays visible as a Lane-scope error.
- BR4 B1: `CommerceJoin.tsx` `const tenantSlug = useActiveTenantSlug()` replaces the literal at `:142,149,176`, and the
  `:9-12` comment is reworded (the explicit default lives on in `?? 'maxina'`). Both CommerceJoin tests are now in
  paths: `oauth-first.test.ts:29` and `routing.test.ts:55` assert `tenant_slug: tenantSlug` plus that `tenantSlug` comes from `useActiveTenantSlug()`.
  The wrong-tenant warning (`routing.test.ts:53-54`) is kept, reworded.
- BR5 B7: unit tests with a mocked `supabase.auth.signUp` and no network:
  - Signup `options.data.tenant_slug` is `acme` for a mocked active `acme` tenant.
  - It is `maxina` with no tenant.
  - It is `maxina` with no tenant and `localStorage.tenant_slug = 'acme'`. This guards s2 R1-F3.
  - AuthGuard retry: `activeTenantSlug` returns a registry-listed stored slug, and `maxina` for an unlisted one.
  - `App.tsx` calls `useTenantMeta()` inside `AppHooksInitializer`.
- BR3 Pre-push gate: stamp drift 0 for every locale, audit 100.0% for the 10 non-DE locales, and
  `git diff --name-only origin/main...HEAD` ⊆ paths. The new `tenantBrand` keys show as "never stamped". That is
  expected and is not drift: `i18n-stamp-source.mjs` files them under `unstamped` (`:289`), counts only mismatches into
  `totalDrift` (`:293`) and exits 1 only on `totalDrift > 0` (`:335-342`). I18N-PROPAGATE's COUNT (`:86-88`) matches
  only the drift line. So no stamp file is needed, and `i18n-source-stamps/**` stays outside paths (s2 R1-F4).

**Lane `theme-tokens-r3` (kiro, seat exafyltd, vitana-v1).** Runtime HSL overrides for non-default tenants only; no CSS
change:
- New `src/lib/tenant-theme.ts`:
  - `hexToHslTriplet(hex)` converts `#rgb`/`#rrggbb` to `"H S% L%"` (one decimal) and returns null when invalid.
  - `tenantThemeVars(tenant)` returns `{}` for a missing tenant, slug `maxina` or no valid `brandAccent`
    (`tenant-registry.ts:107`). Otherwise it returns `--primary` from `brandAccent` (never `--ring`, R3-F1), and
    `--primary-foreground` from a valid `brandFg` (`:109`).
  - Scheme-neutral variables only: `--background`/`--foreground`/`--accent` are not overridden (conservative,
    recorded).
- `useTenant.tsx:123-133`: keep the `--brand-*` writes unchanged and `setProperty` the `tenantThemeVars` after them. The
  effect's cleanup (on unmount and tenant change) runs `removeProperty` on exactly the keys that run set (closure over
  `Object.keys(vars)`; `--brand-*` get no cleanup, R3-F2), so switching back to
  Maxina restores the stylesheet values (`index.css:24,41` / `:269,286`). Update the "nothing consumes them yet — C2"
  comment (`:123`).
- No change to `src/index.css`, `tailwind.config.ts`, `scripts/native/gen-tokens.mjs`, `packages/**` or the C2 golden
  (`maxina-golden.test.tsx:172-187` stays true: the new code never writes `var(--brand-`). Maxina never gets an inline
  `--primary`, built CSS is byte-identical, and native tokens show no drift.
- Rejected:
  - A CSS fallback chain: it renders pink, feeds hex into `hsl()` and breaks native.
  - Teaching gen-tokens `var(x, fallback)`: the value is still hex at runtime, with a larger blast radius.
  - Switching the `--brand-*` writes to HSL: MaxinaPortal's `#FF7BAC` (`:234`) would start rendering on Maxina.

The two lanes' path sets are disjoint from each other and from the four live `mt-frontend-brand` lanes.

## Lane paths (complete; identical to each lane file's `paths:` front matter)
Created in this PR with these exact lists (s2 R2-F1). Every new or modified file of the Fix is in them, so the BR3 gate
`git diff --name-only origin/main...HEAD ⊆ paths` and CI Lane scope can pass. `scopeCheck` matches globs
(`queue.mjs:112` `globToRegex`), and `docs/validation/<vtid>/` is exempt (`:991`).
- `brand-surface-r3`: `src/pages/CommerceJoin.tsx`, `src/pages/CommerceJoin.oauth-first.test.ts`,
  `src/pages/CommerceJoin.routing.test.ts`, `src/components/AuthGuard.tsx`, `src/pages/RedeemVoucher.tsx`,
  `src/components/voucher/RedemptionLanding.tsx`, `src/lib/store-links.ts`, `src/lib/store-links.test.ts`,
  `src/hooks/useTenantMeta.ts` (new), `src/hooks/useTenantMeta.test.ts` (new), `src/App.tsx`,
  `src/i18n/{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}/tenantBrand.json` (11 explicit entries, new),
  `docs/SCREEN_INVENTORY.md`, `tests/e2e/staging/vtid-*-brand-surface.staging.spec.ts` (new). The BR5 tests live in
  `useTenantMeta.test.ts` and the two CommerceJoin tests; `src/hooks/useTenant.tsx` is only imported, not edited.
- `theme-tokens-r3`: `src/lib/tenant-theme.ts` (new), `src/lib/tenant-theme.test.ts` (new), `src/hooks/useTenant.tsx`,
  `src/hooks/useTenant.theme.test.tsx` (new), `tests/e2e/staging/vtid-*-theme-tokens.staging.spec.ts` (new).

## Migrations
None.

## Tests
- **`brand-surface-r3`:**
  - `npx vitest run src/hooks/useTenantMeta.test.ts src/lib/store-links.test.ts src/pages/CommerceJoin.oauth-first.test.ts src/pages/CommerceJoin.routing.test.ts`
    is green. The new signup assertion fails on V1 main (literal `maxina` for `acme`).
  - Full `npx vitest run` is green except failures already red on main, listed in `commands.log`.
  - ESLint `i18n/*` + `design/*` clean. CI Lane scope green with no `github-actions[bot]` commit; `i18n-check.yml`
    stamps/register green.
  - `src/App.tsx` diff = one import + one `useTenantMeta();`.
- **`theme-tokens-r3`:**
  - `tenant-theme.test.ts`: triplet conversion, `{}` for Maxina/null/no accent, 3 vars for `acme`.
  - `useTenant.theme.test.tsx` (jsdom, mocked registry/Supabase, following `src/hooks/useTenant.registry.test.tsx`):
    Maxina leaves inline `--primary` empty, `acme` gets the triplet (fails on main), acme → Maxina clears it, and the
    `--brand-*` writes are unchanged.
  - `gen-tokens.mjs --check` exits 0. `git diff --exit-code origin/main -- src/index.css tailwind.config.ts packages/`
    is clean. `dist/assets/*.css` sha256 is equal on main and head. C2 golden green and unchanged.

## Staging verification
Read-only (rule 48), on `https://preview-aws.vitanaland.com` only. The spec throws on any other host. A network guard
aborts every non-GET to the gateway and Supabase REST except `auth/v1/token?grant_type=password`. It signs in as the
test user via the REST snippet.
- `tests/e2e/staging/vtid-<vtid>-brand-surface.staging.spec.ts`: `/commerce/join` and the voucher landing show
  Maxina's title/favicon and a `/maxina` portal link.
- `tests/e2e/staging/vtid-<vtid>-theme-tokens.staging.spec.ts`: on `/maxina`, computed `--primary` is
  `222.2 47.4% 11.2%` (light) / `210 40% 98%` (`.dark`), and inline `--primary` is empty. No non-Maxina tenant exists
  in production (D13), so the tenant override is proven by Vitest only; `staging-tests.json` lists it as `existing`.

Each lane's record is `docs/validation/<its new VTID>/staging-tests.json`.

## Rollout
No flag. Maxina is byte-identical by construction:
- brand-surface: the active slug is `maxina` on every serving host.
- theme-tokens: no CSS change, and a slug guard.

Tenant values only render for a non-Maxina tenant, which cannot exist in production until an owner-approved
provisioning step (D13).

## Risks
- **I18N-PROPAGATE still pushes into the brand-surface PR.** Mitigation: the BR0 precondition plus the BR3 pre-push
  gate. After each push, confirm there is no bot commit. If one appears, stop and log it; never re-push to force it.
- **Cherry-picks no longer apply on the new main.** Mitigation: re-implement to the spec above. The spec, not `#1485`,
  is authoritative.
- **Inline overrides leak across tenant switches.** Mitigation: remove exactly the set variables; unit test acme →
  Maxina.
- **Superseded lanes are left open.** Mitigation: the PM / exceptions seat parks both and cancels VTID-05242/05246 after
  convergence; recorded in `handoff.md`.

## Out of scope
- Everything else of `mt-frontend-brand` (its four other lanes stay there).
- Overriding `--background`/`--foreground`/`--accent` per tenant (a later lane).
- Native brand (WS9).

## Depends on
Done: VTID-05151 (registry/portal/`useTenant`, `src/hooks/useTenant.tsx:1`). The code on `vitana-v1#1485` is reused,
not merged.

## Owner decisions
No new owner decision. D13 (no synthetic tenant in prod); owner instruction 2026-10-21/22 (full automation to verified
staging).
<!-- plan:end -->
