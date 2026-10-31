# Design — spotlight-compact-hero

All `file:line` references are into `exafyltd/vitana-v1` on `origin/main` (the PLAN-SPAR
partner reads them through the `spar_refs` companion pinned in `handoff.md`).

## 1. What "too big" actually is

The `dashboard` archetype maps to layout width `stage-rail`
(`src/components/layout/spotlight/archetypes.ts:34`), but is a **single centred stage** on the
real pages because none of them pass a `rail`:

- `src/pages/Health.tsx:442` — `<ScreenFrame archetype="dashboard" …>` with only `children`.
- `src/pages/Wallet.tsx:546` — same, plus `tabs`.
- `src/pages/health/VitanaIndexDetail.tsx:650` — same.
- `src/pages/AutopilotDashboard.tsx:484` — same.

`SpotlightLayout` renders the rail only when `width === 'stage-rail' && rail != null`
(`src/components/layout/spotlight/SpotlightLayout.tsx:38`), and the CSS only widens the grid
to two columns for `.sp-grid:has(> .sp-rail)` (`src/index.css:443-444`). So the stage is a
single column capped at `--sp-stage-max: 760px` (`src/index.css:188`).

The hero is a `spotlight` VCard filling that 760px width with a 16:9 media box
(`src/components/ui/vcard/VCard.tsx` `mediaBoxClass` → `aspect-video w-full`) and a tall body.
For Health / Vitana Index it is the shared `VitanaIndexHeroCard`
(`src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx:18`); for Wallet it is an inline
`<VCard size="spotlight">` (`src/pages/Wallet.tsx:573`); for My Journey it is a
`size="spotlight"` card inside `AutopilotDashboard.tsx`. The hero has no media image passed
in practice, so the "dinosaur" is the full-width card with a large padded body (`p-5`,
`VCard.tsx` stacked branch) and, for Health, the five-pillar list.

## 2. Contract tension to resolve (the real design decision)

Three mechanisms require **exactly one `spotlight`-size element** on every dashboard screen:

1. `docs/design-system/SPOTLIGHT_RULES.md` SR-06 / SR-07.
2. The Tier B composition test
   `src/pages/spotlight-tier-b.vtid-05111.test.tsx:223-228`: for each `dashboard` route it
   counts `size="spotlight"` + `<VitanaIndexHeroCard` and asserts the count is 1–2.
3. The staging design-lint `tests/e2e/staging/design-contract.staging.spec.ts:137` and
   `tests/e2e/staging/vtid-05111-tier-b.staging.spec.ts:137`: exactly one
   `[data-vcard-size="spotlight"]` in the first viewport.

**Decision: keep the compact hero as the ONE `spotlight` VCard, in a new compact
presentation — do NOT drop the `spotlight` size and do NOT add a new size token.** The
`spotlight` VCard already supports a text-only card (no `media` prop → no media box,
`VCard.tsx` `hasMedia` is false). The compact band is a `spotlight` VCard rendered *without*
media and with a short, single-row body (ring + headline + "+N this week" + one-line insight),
so its height is content-driven (~1/3 of today's) and uses only the 4px spacing scale and the
fixed type scale (SR-15, SR-16). This satisfies all three mechanisms unchanged while making
the card small. SR-06/SR-07 are preserved verbatim; the contract text gains a *presentation*
clause for `dashboard`, not a new size.

If, during build, the compact band cannot hit ~1/3 height without a fixed pixel height (which
`design/no-arbitrary-size` forbids, SR-12/SR-14), that is a genuine contract addition (a new
hero-band height token) and is **flagged to the owner in `plan.md`, not invented**. The design
avoids it: dropping the media box and collapsing the body to one row already removes the bulk.

## 3. The bento grid

Below the compact hero, a bento grid of `standard` VCards (media ratio 4:3, `VCard.tsx`
`mediaBoxClass` `standard` branch). The existing Tier B grid tokens already express this:
`TIER_B_GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'`
(`src/components/spotlight/tier-b/TierBKit.tsx:18`). On the 760px stage a 2-col grid gives
tiles of ~360px and a 3-col grid ~240px — a 2-col tile is ~47% and a 3-col tile ~31% of the
stage. **To keep "no tile > ~40% of the stage width" (R1), the dashboard bento uses the 3-col
grid at the stage's full width (`TIER_B_GRID`, which is 3-col from `xl`), and any full-row
emphasis tile spans the whole row rather than being a wider single tile.** No tile is given a
width greater than one grid column. This is tokens-only and needs no new CSS.

"Up Next" becomes one `standard` tile in this grid (see §4).

## 4. Rail decision — KEEP where it exists, add none (revised, sparring R1-F1)

Correction to §1: My Journey (`/autopilot`, `/autopilot/audiobook`) DOES pass a rail —
`rail={<JourneyRail …/>}` at `src/pages/AutopilotDashboard.tsx:508` (compact VCards only,
`JourneySpotlight.tsx:116`). That rail is KEPT unchanged: it already satisfies SR-08 and the
stage-rail layout, and removing it would drop the autopilot-count context and the toggle sheet.
Health, Vitana Index and Wallet stay rail-less (no rail added); their "Up Next" content becomes
a `standard` tile in the bento grid. `plan.md` D1 is the source of truth.

## 5. Shared component + per-page adoption

A new shared component `DashboardHeroBand` (compact `spotlight` band) and a grid helper live in
`src/components/spotlight/tier-b/`, beside `VitanaIndexHeroCard` and `TierBKit`. Each dashboard
page swaps its current full hero for the compact band and arranges its existing content cards
into the bento grid. `VitanaIndexHeroCard` gains a `compact` presentation (no media, one-row
body, pillars off) so Health and Vitana Index reuse it; Wallet and My Journey render their own
compact `spotlight` band via `DashboardHeroBand`. Every dashboard page keeps exactly one
`spotlight` element.

## 6. Skeleton parity (R3)

`src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx:42-51` currently renders a
`VCardSkeleton size="spotlight"` (tall, with the 16:9 box) + a 3-col `standard` grid for
`dashboard`. The media-less compact band must have a matching skeleton so CLS stays < 0.1
(SR-21). `VCardSkeleton` renders the `spotlight` media box unconditionally
(`src/components/ui/vcard/VCardSkeleton.tsx:12-20`). Add a `compact`/media-less skeleton shape
(a short band skeleton with no media box) and use it in the `dashboard` branch of both
`ArchetypeSkeleton` and `SpotlightLoading` (`SpotlightLoading.tsx` `MobileShape` dashboard
branch stays mobile and unchanged; only the desktop `ArchetypeSkeleton` path changes). The
grid skeleton switches to 3 columns to mirror §3. `SpotlightLoading.test.tsx` and the
skeleton's own tests are updated to the new shape.

## 7. ESLint, ratchet, manifest (R4)

- The compact band and the grid use only existing tokens and the 4px scale, so new component
  files are `design/*`-clean. No `h-[…]`/`w-[…]`, no raw palette, logical props only.
- The **contract ESLint rules** (`eslint-rules/design/**`) only change if the enforceable
  surface changes. The compact-hero rule is a *presentation* rule, enforced by the existing
  SR-06/SR-07 count (unchanged) and the staging spec, so `eslint-rules/design/**` is expected
  to be **untouched** — meaning no `design.json` baseline rewrite is required. If a lane does
  touch `eslint-rules/design/**`, that PR must commit a `scripts/ci/pr-gate/baseline/
  design.json` equal to the current counts (the contract-change exception,
  `SPOTLIGHT_RULES.md` §C). The design ratchet otherwise only needs to stay ≤ the base-commit
  counts; new files at 0 keep it green.
- No manifest archetype or route changes: the five `dashboard` routes keep `archetype:
  "dashboard"` and `status: "migrated"`. `npm run design:manifest` is run to confirm no drift.

## 8. Verification (R7, local only)

- `npx eslint <changed files>` → 0 `design/*`.
- `node scripts/ci/pr-gate/gate.mjs ratchet-design` style check green vs `origin/main`.
- `npm test` (or scoped vitest) — manifest test, `spotlight-tier-b.vtid-05111.test.tsx`,
  `VitanaIndexHeroCard` test, `SpotlightLoading.test.tsx`, `spotlight.vtid-05105.test.tsx` all
  green; `tsc` via the build.
- `npm run build` then `npm run preview`; Playwright signed-out / mocked at 1400×900 desktop:
  before/after screenshots of `/health?spotlight=1`, `/wallet?spotlight=1`,
  `/health/vitana-index?spotlight=1`, `/autopilot?spotlight=1` showing the compact band + bento
  grid and one spotlight element in the first viewport; a 390×844 shot of `/health` proving the
  phone layout is unchanged. No live systems.
- `npm run i18n:inventory` only if any user-visible string is added (commit the regenerated
  `docs/SCREEN_INVENTORY.md`).
