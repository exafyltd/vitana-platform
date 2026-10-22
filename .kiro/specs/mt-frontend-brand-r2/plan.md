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

The four other lanes (`adminfetch-header` VTID-05241, `cors-config` VTID-05243, `email-brand-code` VTID-05244,
`email-brand-db` VTID-05245) are unchanged and stay in `mt-frontend-brand`. After this plan converges the PM /
exceptions seat parks the two old lanes as superseded and terminalizes VTID-05242 and VTID-05246 `cancelled`; Kiro
never writes the ledger. `vitana-v1#1485` is closed unmerged with its branch kept; its non-bot code is reused (BR1).

## Evidence base (what the partner can read)
- **vitana-v1 at `96becaed99bdb91d0a999a4f516a3f68cd6d4bc3`** (its `origin/main` at re-plan time), declared in
  `handoff.md` `spar_refs`. Every `vitana-v1` `file:line` below is at that SHA unless marked "PR evidence".
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
- Lane `paths` are frozen. `queue.mjs:679-688` rejects a `paths`/`executor`/`seat`/`reviewer_seat` change in a lane PR
  unless the lane is `executor: claude`. A `_plan` commit "may create a lane file, never edit one" (`queue.mjs:585-587`).

## Problem
1. **brand-surface cannot pass Lane scope.** V1 `PR-GATE.yml:297-326` runs `queue.mjs scope-check`.
   `scopeCheck` (`queue.mjs:628-`) diffs `base...head` over all commits (`:689`). Its only exemptions are the spec
   folder and `docs/validation/<vtid>/` (`:690`), and the trailer scan (`commitsInRange`, `:490-500`) has no
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
   lane's paths. Other literals the lane owns (B2–B5, unchanged scope): `AuthGuard.tsx:267,271` (`|| 'maxina'`),
   `RedemptionLanding.tsx:47,51` (`/maxina?redirectTo=`), `:61-62` (logo + alt `MAXINA`),
   `RedeemVoucher.tsx:66,104,131,157` (`navigate("/maxina")`), and `store-links.ts:6,31`. The mount point
   `AppHooksInitializer` is at `src/App.tsx:469` and is rendered at `:772`.
3. **theme-tokens' approach is wrong.**
   - `src/index.css:137-140` (`:root`) and `:384-387` (`.dark`) already declare `--brand-accent: 339 89% 49%` (pink),
     so `--primary: var(--brand-accent, …)` would render pink for Maxina, where `--primary` is `222.2 47.4% 11.2%`
     (`:24`) / `210 40% 98%` (`:269`). The old plan's "fallback == compiled value" premise is false.
   - `useTenant.tsx:123-133` writes `safeHex(...)` values (hex; `safeHex` at `src/lib/tenant-registry.ts:115`), and
     `MaxinaPortal.tsx:232-237` writes `#FF7BAC`/`#FFF5F8`/`#1A1A1A`. `tailwind.config.ts:61,65-66` emit
     `hsl(var(--ring))`/`hsl(var(--primary))`, and `index.css:6` requires HSL, so a hex in that chain is an invalid
     colour.
   - `scripts/native/gen-tokens.mjs:97-104` substitutes only `var(--x)` (no fallback form), so `--primary` would drop
     out of `packages/tokens` (`packages/tokens/src/contract.ts:73-79` `SEMANTIC_KEYS` includes `primary`, `ring`),
     breaking native.
   - The C2 golden `src/lib/tenant-registry.maxina-golden.test.tsx:172-187` asserts that nothing consumes
     `var(--brand-*)`. An approach that never reads `var(--brand-*)` keeps it true.

## Fix
**Lane `brand-surface-r2` (kiro, seat exafyltd, vitana-v1).** Same scope as `brand-surface` (B1–B7 of the original
plan), rebuilt so Lane scope can pass:
- BR0 precondition, before the first commit: on the lane base run `node scripts/i18n-stamp-source.mjs --check-all`
  and `node scripts/i18n-audit.mjs`. If main itself has drift, or a ga locale below 100%, I18N-PROPAGATE would push into
  any `de/**` PR whatever the lane does. Stop, log it with `next_actor: claude`, and push nothing.
- BR1 Fresh branch from V1 main. Cherry-pick only the non-bot code of `#1485` (`e31230ac6`, `7a8b2ab74`), never a
  `github-actions[bot]` commit, re-trailered `Collab-Lane: mt-frontend-brand-r2/brand-surface-r2`. If a pick
  conflicts with main, re-implement it to the spec below instead of resolving toward the PR.
- What the lane introduces (absent at the pinned SHA):
  - `src/hooks/useTenantMeta.ts` exporting `activeTenantSlug({ tenantSlug, hostname, candidates })`, a pure function,
    and `useActiveTenantSlug()`. It returns the `useTenant()` slug when set, else a stored canonical slug
    (`readStoredTenantSlug`, as `AuthGuard.tsx:74`), else `maxina`. `vitanaland.com` and the preview host therefore
    resolve to `maxina`, exactly today's literal.
  - `useTenantMeta()` sets `document.title` + favicon only (no OG, original R1-F4), mounted by one call in
    `AppHooksInitializer` (`App.tsx:469`).
- BR2 Ship `tenantBrand.json` in all 11 active locales (DE first, du-form; `{brand}` kept; `ar` RTL text) so
  I18N-PROPAGATE's drift is 0 and it pushes nothing. `screens.json` and `i18n-source-stamps/**` are deliberately not in
  paths, so any bot touch stays visible as a Lane-scope error.
- BR4 B1: `CommerceJoin.tsx` `const tenantSlug = useActiveTenantSlug()` replaces the literal at `:142,149,176`, and the
  `:9-12` comment is reworded. Both CommerceJoin tests are now in paths: `oauth-first.test.ts:29` and
  `routing.test.ts:55` assert `tenant_slug: tenantSlug` plus that `tenantSlug` comes from `useActiveTenantSlug()`.
  The wrong-tenant warning (`routing.test.ts:53-54`) is kept, reworded.
- BR5 B7: a signup unit test (mocked `supabase.auth.signUp`, no network) asserts the active slug for a mocked `acme`
  tenant and `maxina` without one. An AuthGuard retry-slug test covers `activeTenantSlug({ tenantSlug: null,
  candidates: [stored] })`. A test asserts that `App.tsx` calls `useTenantMeta()` inside `AppHooksInitializer`.
- BR3 Pre-push gate: stamp drift 0 for every locale, audit 100.0% for the 10 non-DE locales, and
  `git diff --name-only origin/main...HEAD` ⊆ paths.

**Lane `theme-tokens-r2` (kiro, seat exafyltd, vitana-v1).** Runtime HSL overrides for non-default tenants only; no CSS
change:
- New `src/lib/tenant-theme.ts`:
  - `hexToHslTriplet(hex)` converts `#rgb`/`#rrggbb` to `"H S% L%"` (one decimal) and returns null when invalid.
  - `tenantThemeVars(tenant)` returns `{}` for a missing tenant, slug `maxina` or no valid `brandAccent`
    (`tenant-registry.ts:107`). Otherwise it returns `--primary` and `--ring` from `brandAccent`, and
    `--primary-foreground` from a valid `brandFg` (`:109`).
  - Scheme-neutral variables only: `--background`/`--foreground`/`--accent` are not overridden (conservative,
    recorded).
- `useTenant.tsx:123-133`: keep the `--brand-*` writes unchanged and `setProperty` the `tenantThemeVars` after them. The
  effect's cleanup (on unmount and tenant change) runs `removeProperty` on exactly those keys, so switching back to
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

## Migrations
None.

## Tests
- **`brand-surface-r2`:**
  - `npx vitest run src/hooks/useTenantMeta.test.ts src/lib/store-links.test.ts src/pages/CommerceJoin.oauth-first.test.ts src/pages/CommerceJoin.routing.test.ts`
    is green. The new signup assertion fails on V1 main (literal `maxina` for `acme`).
  - Full `npx vitest run` is green except failures already red on main, listed in `commands.log`.
  - ESLint `i18n/*` + `design/*` clean. CI Lane scope green with no `github-actions[bot]` commit; `i18n-check.yml`
    stamps/register green.
  - `src/App.tsx` diff = one import + one `useTenantMeta();`.
- **`theme-tokens-r2`:**
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
