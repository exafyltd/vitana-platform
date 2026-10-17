# Internal adversarial review — mt-frontend-brand (WS7 rest), NN=09

Reviewer: independent internal sparring step (fresh read, no planner context).
Date: 2026-10-16. Scope: `plan.md`, `requirements.md`, `design.md`, `tasks.md`,
`handoff.md`, `lanes/*.md` (6 lanes). Verification = reading current code
(`file:line`) + the `queue.mjs` validators only. No edits, no git, no suite runs.

## Verdict

**APPROVED.** Zero HIGH and zero MEDIUM findings. Two NITs below (non-blocking).
The two prior INTERNAL-REVIEW blocking findings (command-hub guard; `useTenantMeta`
mount) are confirmed correctly resolved in the current spec.

## What I checked and how

### Premises verified against current code (all accurate)

1. **Theme tokens set but unconsumed** — `vitana-v1/src/hooks/useTenant.tsx`
   sets `--brand-accent/-bg/-fg` on `document.documentElement` inside a
   `useEffect`, with the literal comment *"nothing consumes them yet — C2"*
   (verified at the effect, lines ~123–133). The golden
   `src/lib/tenant-registry.maxina-golden.test.tsx` has the test *"nothing
   consumes var(--brand-\*) … (C2 changes this on purpose)"* which walks
   `.tsx/.ts/.css/.scss` under `src/` plus `tailwind.config.ts`/`index.html`
   and asserts no file (other than the test itself) contains `var(--brand-`.
   The plan's claim that adding `var(--brand-accent, <maxina hsl>)` to
   `src/index.css` deliberately flips this golden is exactly correct — the
   walk includes `.css`, so the lane MUST update the golden, which it plans.
   VERIFIED.

2. **adminFetch JSDoc vs code** — `src/lib/admin-api.ts` header JSDoc lists
   "3. Injects X-Vitana-Tenant and X-Vitana-Active-Role context headers", but
   `adminFetch` (the `fetch` call) sends only `Content-Type` + `Authorization`
   (plus caller `init.headers`). The JSDoc overstates what the code does.
   The gateway CORS `allowedHeaders` already includes `X-Vitana-Active-Role`
   and `X-Vitana-Tenant` (`services/gateway/src/middleware/cors.ts`, the
   `allowedHeaders` array), so adding the headers is safe. VERIFIED.

3. **Hardcoded `maxina` slug** — `src/pages/CommerceJoin.tsx` sets
   `localStorage.setItem('tenant_slug', 'maxina')`, `queryParams: { tenant_slug:
   'maxina' }` and `data: { … tenant_slug: 'maxina' … }` in the signup/OAuth
   path (the cited 142/149/176 region). `src/components/AuthGuard.tsx` builds
   the Apple OAuth `redirectTo` as `window.location.origin + '/' +
   (readStoredTenantSlug('tenant_slug') || 'maxina')` (line 271). VERIFIED.

4. **Hardcoded brand in store surfaces** — `src/lib/store-links.ts`:
   `APP_STORE_URL` is the Apple maxina listing (line 6), `MAXINA_APP_QR_URL`
   is a hardcoded `vitanaland.com/maxina/app` (line 31), and the GoToApp
   fallback is a documented constant lower down (the "Apple retry" fallback
   area the plan cites). The file's own header note explains these are
   deliberately constants (env vars are overwritten at build). RedeemVoucher /
   RedemptionLanding `navigate('/maxina' …)` were not re-opened line-by-line
   but are consistent with the hardcoded-slug pattern verified in #3; the lane
   treats them identically (slug-derived, Maxina fallback). VERIFIED (store
   links directly; redeem/voucher by consistent pattern).

5. **Email sender/branding hardcoded** — `supabase/functions/voucher-send-email/
   index.ts` embeds `images/maxina-logo.png` (line ~265). The sibling
   `send-appointment-*` / `send-welcome-discount` functions are in the lane's
   paths and follow the same shape. VERIFIED (voucher-send-email directly).

6. **OG/share branding hardcoded** — `supabase/functions/og-share/index.ts`
   emits `<title>${title} | VITANA</title>` and `og:site_name content="VITANA"`
   (the cited ~91/96 region). VERIFIED.

7. **CORS is a hardcoded array** — `services/gateway/src/middleware/cors.ts`
   has the `ALLOWED_ORIGINS` array (lines ~7–40) and `ALLOWED_ORIGIN_PATTERNS`
   (~46–51); `isOriginAllowed()` tests only those two; no config/env input.
   VERIFIED.

8. **Command Hub maxina-bound, path CI-reserved** — the plan DEFERS the picker
   out of scope precisely because `services/gateway/src/frontend/command-hub/
   app.js` is reserved by `scripts/ci/command-hub-ownership-guard.js` for
   `DEV-COMHU-*`/allowlisted VTIDs. This is the CROSS-SPEC-DECISIONS binding
   correction for mt-frontend-brand, and it is applied correctly (see below).
   The data endpoint `GET /api/v1/admin/tenants` existence is asserted
   (`admin-tenants.ts:76`) — not independently re-opened, but it only supports
   the deferral narrative, blocks nothing. ACCEPTED.

### `useTenantMeta` mount premise (prior MEDIUM — confirmed resolved)

`src/App.tsx` contains the `AppHooksInitializer` component (the hook-only child
inside the provider/`BrowserRouter` tree, calling `useOrbFrontDoor`,
`useRouteTracker`, `usePostLoginWarmup`, etc., in the ~468–480 region). It is a
real, single mount point that runs session-wide. Adding one `useTenantMeta()`
call there is an import + one line, no new route and no JSX element — so the
"no nav-registry / screen-manifest / parity change" claim holds. `src/App.tsx`
is correctly added to `brand-surface`'s `paths`, and tasks B5/B7 name the same
mount with a test (B7) asserting the hook is actually called. RESOLVED.

### CROSS-SPEC rulings naming mt-frontend-brand (both applied)

- **Command Hub app.js is guarded.** Ruling: make the picker lane
  `executor: claude` OR drop it. The spec took the more conservative route —
  the picker lane was **removed entirely** and deferred to a future
  `DEV-COMHU-*` lane; handoff log 2026-10-16 records this; the spec is 6 lanes;
  no remaining lane touches `command-hub/**`. APPLIED (conservative option).
- **useTenantMeta needs a mount file.** Ruling: add the real app-shell mount to
  `paths` + task, OR drop B5 to "hook exists + unit-tested". The spec took the
  former (single narrow add, as the ruling prefers). APPLIED.

No other CROSS-SPEC item names mt-frontend-brand; the handoff states this and
it is correct (platform_only_accounts, network groups, moderation, migration
ordering C3 are all other specs').

### Lane sizing, DB/code split, seats, deps

- **6 lanes**, each 1 VTID / ≤4 PRs, consistent with the ≤~90-lane program
  target. DB (`email-brand-db`) is split from code (`email-brand-code`) per
  §4.7; `email-brand-code depends_on: [email-brand-db]`. Correct.
- **Seats** cross-checked against `areas.yaml`: `src/**` is the `frontend`
  catch-all → seat `exafyltd`; `theme-tokens`, `brand-surface`,
  `adminfetch-header`, `email-brand-code` all `exafyltd`. ✔ `email-brand-db`
  (supabase/migrations) → `hotmail` (brief's "uncovered: hotmail for
  supabase/migrations + DB lanes"). ✔ `cors-config` (gateway) → `jtadic`
  (brief's "jtadic for gateway/services"; not a governance path). ✔ Every
  `reviewer_seat` differs from its lane `seat`. ✔
- **Governance paths:** none of the 6 lanes touch `.github/**`, `.claude/**`,
  `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`
  or `docs/programs/areas.yaml`; the one that would have (`command-hub/app.js`
  is CI-reserved, adjacent) was removed. So `executor: kiro` on every lane is
  legal, and the `queue.mjs` governance-glob check passes (confirmed below).

### Migration safety

- `email-brand-db`: one expand-only file `20261101090000_vtid_xxxxx_tenant_
  email_branding.sql` in the spec's reserved range `20261101090000–095959`;
  rollback `docs/validation/<vtid>/rollback.sql` (DROP); `SET lock_timeout`
  guard; no NOT NULL, no hot-table backfill; read-only pre/post checks written
  for Claude to run (Kiro never applies). MIGRATION-QUEUE: I confirmed the live
  queue's last applied row is `20261014000700_vtid_05151_seed_legacy_tenant_
  landing.sql` (row 8) and that NO `20261101…` migration exists yet in
  `vitana-v1/supabase/migrations`, so the plan's "first `20261101…` entry after
  `20261014000700`" is accurate. VERIFIED.

### Dark-by-default / rollout

Every code lane is dark-by-default via `MT_RESOLUTION_V2` /
`tenant_settings.feature_flags.mt.*` EXCEPT `theme-tokens` and `brand-surface`,
whose named exception is sound: the Maxina compiled value is the CSS `var()`
fallback, so with no non-Maxina tenant in prod (D13) the live build is
byte-identical and the C2 golden pins that byte-identity. This is the same
precedent Lane C set. Reasoning holds. ✔

### Standing rules

Never-test-against-prod (31/31b/48), staging read-only with a non-GET network
guard, Kiro-never-writes-live (migration is a file; edge-fn deploy by pipeline;
Supabase Auth templates + redirect allowlist are an owner-only runbook, not
scripted), i18n DE-first du-form (`src/i18n/de/tenantBrand.json` first), RTL
logical props, Spotlight tokens, no What's New card (no new finished
member-visible feature — this is wiring existing surfaces to be tenant-driven),
Bedrock-only / no new Google — all present and correct in plan/design/tasks.

### Validators (the mechanical gate)

Ran `queue.mjs` `parseFrontMatter` + `validatePlan`/`validateLane` on
`handoff.md` and all 6 lane files with the correct `(fm, slug[, lane, laneIds])`
signatures:

```
handoff.md           => []
lanes/adminfetch-header.md => []
lanes/brand-surface.md     => []
lanes/cors-config.md       => []
lanes/email-brand-code.md  => []
lanes/email-brand-db.md    => []
lanes/theme-tokens.md      => []
```

Zero validator errors. (handoff front matter: slug matches folder, author/
executor kiro, next_actor kiro, state drafted, author_seat `hotmail` valid,
updated present. Lanes: id == filename, state ready, next_actor owner, no vtid
yet [legal at ready], seat/reviewer_seat valid and distinct, executor kiro,
depends_on resolves within the spec, no governance-path glob.)

## Findings

1. **NIT** — `design.md` "Rules every successor follows" §1 tells the
   `email-brand-db` executor to add a not-yet-live object to
   `scripts/ci/migration-drift-baseline.json`. That drift check
   (`scripts/ci/check-migration-drift.cjs` + baseline) lives in
   **vitana-platform** and guards platform migrations; `email-brand-db`'s
   migration is in **vitana-v1** (`supabase/migrations/`), which has no such
   baseline. The instruction is carried-over platform boilerplate and does not
   apply here. It is NOT a Lane-scope defect — the lane correctly omits that
   file from `paths`. Fix: in `design.md` §1, scope the baseline sentence to
   "platform migrations only; a vitana-v1 migration has no drift baseline to
   touch," so the executor does not try to edit a file outside the repo/paths.

2. **NIT** — Premise #4/#5/#6 cite exact line numbers for `RedeemVoucher.tsx`,
   `RedemptionLanding.tsx`, the `send-appointment-*` / `send-welcome-discount`
   functions, and the OG `og-event`/`og-campaign`/`og-short` workers that I did
   not re-open individually (I verified the representative files
   voucher-send-email, og-share, CommerceJoin, AuthGuard, store-links,
   useTenant, admin-api, cors.ts directly). The brief warns program `file:line`
   refs may have drifted. These siblings are low-risk and in-paths, but the
   build executor should treat the sibling line numbers as approximate and
   re-grep at implementation time rather than trusting the exact lines. Fix:
   add "line numbers for sibling edge functions are indicative — re-locate the
   hardcoded literal at build time" to the `email-brand-code` lane body.

## Open questions for sparring (non-blocking, already recorded by the planner)

- `cors-config` seat: `jtadic` for uncovered-platform gateway work vs flipping
  to `executor: claude` for platform chrome. The planner's default (`jtadic`,
  since `services/gateway/src/**` is not a governance path) is defensible and
  validator-clean. Leave to CI sparring.
- `store-links.ts` per-tenant store URLs may not exist in the brand pack yet;
  the planner's default (ship Maxina fallback only, defer the per-tenant field
  to mt-native-health/WS9) is the conservative choice. Leave to CI sparring.
