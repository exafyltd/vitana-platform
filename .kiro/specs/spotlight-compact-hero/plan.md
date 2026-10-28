# Plan — spotlight-compact-hero

<!-- plan:begin -->
## Goal

Shrink the oversized Spotlight hero on the desktop `dashboard` archetype to a compact
horizontal band (~1/3 of today's hero height) and add a denser bento grid of medium `standard`
cards below it, as a design-contract change applied to **every** `dashboard` screen. Desktop
Spotlight content-area only; sidebar/shortcut bar, top bar, utility tabs, ORB, dark theme and
all mobile layouts unchanged; RTL-safe (logical classes only). Rides the existing
`desktop_spotlight` tenant flag (off by default, previewable with `?spotlight=1`); flipping the
tenant default stays the owner's call.

Repo: `exafyltd/vitana-v1`. All `file:line` below are on `origin/main`; the PLAN-SPAR partner
reads them via the `spar_refs` companion pinned in `handoff.md`.

## Decisions (made here, not left open)

- **D1 — Rail: FOLD, do not keep.** No dashboard page renders a rail today: `Health.tsx:442`,
  `Wallet.tsx:546`, `VitanaIndexDetail.tsx:650`, `AutopilotDashboard.tsx:484` all pass only
  `children` to `<ScreenFrame archetype="dashboard">`, and `SpotlightLayout` only draws a rail
  when `rail != null` (`SpotlightLayout.tsx:38`; CSS `src/index.css:443`). There is no rail to
  keep. "Up Next" folds into the bento grid as a `standard` VCard. This composes most cleanly in
  the single 760px stage (no `:has(> .sp-rail)` widening, no toggle sheet).
- **D2 — Compact hero stays the ONE `spotlight` VCard, in a media-less compact presentation.**
  SR-06/SR-07, the Tier B composition test (`spotlight-tier-b.vtid-05111.test.tsx:223-228`) and
  the staging design-lint (`design-contract.staging.spec.ts:137`) all require exactly one
  `spotlight` element per dashboard. The `spotlight` VCard already supports a text-only card
  (no `media` prop → no media box, `VCard.tsx` `hasMedia`). The compact band is a `spotlight`
  VCard with no media and a single-row body (small inline Index ring + headline + "+N this
  week" + one-line insight), so height is content-driven (~1/3 of today's) with no fixed pixel
  height. This keeps all three mechanisms unchanged.
- **D3 — No new size token; existing tokens only.** The band uses the 4px spacing scale and the
  fixed type scale (SR-15/16); the bento uses the existing `TIER_B_GRID` 3-col grid
  (`TierBKit.tsx:18`) at full stage width, so a tile is ~31% of the 760px stage (< 40%, R1). A
  2-col tile would be ~47% and is therefore not used for the dominant grid. **If** the ~1/3
  band height genuinely cannot be reached without a fixed-height utility (which
  `design/no-arbitrary-size` forbids, SR-12/14), that is a new hero-band height **token** and a
  contract addition — it is FLAGGED to the owner here, not invented. Current design avoids it
  by dropping the media box and collapsing the body to one row. **As planned, no new token is
  proposed.**

## Steps (one lane: `compact-hero-grid`; CI allocates its VTID on convergence)

1. **Contract text.** Edit `docs/design-system/SPOTLIGHT_RULES.md`: update the `dashboard` row
   of the §A archetype table ("one hero KPI `spotlight`, then `standard` tiles" → "one COMPACT
   hero `spotlight` band, then a bento grid of `standard` tiles") and add to §B: a dominance
   clause that on `dashboard` the single `spotlight` card renders as a compact media-less band
   ~1/3 the height of a full spotlight hero, and a bento clause that no `dashboard` grid tile
   exceeds ~40% of the stage width. SR-06, SR-07, SR-11, SR-12, SR-13 kept verbatim.
   Files: `docs/design-system/SPOTLIGHT_RULES.md`.
   Verify: `npx eslint docs` is n/a; `npm test` manifest + composition tests still pass after
   later steps (the doc alone has no test).

2. **Compact hero component.** Add `src/components/spotlight/tier-b/DashboardHeroBand.tsx` — a
   `spotlight` VCard with no `media`, a one-row body (ring slot + headline + trend/"+N this
   week" pill + one-line insight), tokens and logical props only, `data-testid` for tests.
   Extend `VitanaIndexHeroCard` (`src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx:18`)
   with a `compact` prop that renders the same media-less one-row band (pillars off) so Health
   and Vitana Index reuse it.
   Files: `src/components/spotlight/tier-b/DashboardHeroBand.tsx`,
   `src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx`.
   Verify: new/updated unit tests for both render exactly one `[data-vcard-size="spotlight"]`
   and NO `[data-vcard-media]` box — `npx vitest run src/components/spotlight/tier-b`.

3. **Bento grid helper.** In `src/components/spotlight/tier-b/TierBKit.tsx` add a
   `DASHBOARD_BENTO` grid (reusing `TIER_B_GRID`, 3-col from `xl`, full stage width; a full-row
   emphasis tile spans the row, never a wider single tile).
   Files: `src/components/spotlight/tier-b/TierBKit.tsx`.
   Verify: `npx vitest run src/components/spotlight/tier-b`.

4. **Skeleton parity (SR-20/21, CLS < 0.1).** Add a media-less band skeleton (extend
   `src/components/ui/vcard/VCardSkeleton.tsx` with a `spotlight` + `band`/media-less variant,
   or a local band skeleton in the tier-b dir) and switch the `dashboard` branch of
   `src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx:42-51` to render the band
   skeleton + a 3-col `standard` grid. The desktop path of `SpotlightLoading.tsx` inherits this
   via `ArchetypeSkeleton`; its mobile `MobileShape` dashboard branch is unchanged.
   Files: `src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx`,
   `src/components/ui/vcard/VCardSkeleton.tsx`.
   Verify: `npx vitest run src/components/layout/spotlight` — `SpotlightLoading.test.tsx` and
   `spotlight.vtid-05105.test.tsx` updated to the new dashboard shape and passing.

5. **Adopt on the four dashboard pages.** In the Spotlight branch of each page, replace the
   full hero with the compact band and lay the existing content cards (and a folded "Up Next"
   tile) into `DASHBOARD_BENTO`. One `spotlight` element per page; mobile branches untouched.
   Files: `src/pages/Health.tsx`, `src/pages/health/VitanaIndexDetail.tsx`,
   `src/pages/Wallet.tsx`, `src/pages/AutopilotDashboard.tsx`.
   Verify: `npx eslint <those files>` → 0 `design/*`; `npx vitest run
   src/pages/spotlight-tier-b.vtid-05111.test.tsx` still asserts exactly one spotlight per
   dashboard.

6. **i18n (only if strings added).** New user-visible strings → `src/i18n/de/**` first, then
   `src/i18n/en/**`; `npm run i18n:inventory`; commit `docs/SCREEN_INVENTORY.md`.
   Files: `src/i18n/de/**`, `src/i18n/en/**`, `docs/SCREEN_INVENTORY.md`.
   Verify: `npm run i18n:inventory` clean; i18n ESLint rules pass in `npm run build`.

7. **Full gate + local screenshots.** `npm run build` (tsc + bundle), `npm test`, `npm run
   design:manifest` (no drift). Then `npm run preview` + Playwright signed-out/mocked at
   1400×900 desktop: before/after of `/health?spotlight=1`, `/wallet?spotlight=1`,
   `/health/vitana-index?spotlight=1`, `/autopilot?spotlight=1` (compact band ~1/3 height +
   bento grid, one spotlight element above the fold) and a 390×844 `/health` shot proving the
   phone layout is unchanged. Save under `docs/validation/<VTID>/`.
   Files: `docs/validation/<VTID>/**`.
   Verify: screenshots inspected (spacing, alignment, no clipped text, no mobile overflow); no
   live-system access used.

## Enforcement / ratchet (R4)

- New component and skeleton files are `design/*`-clean (tokens, 4px scale, logical props; no
  `h-[…]`/`w-[…]`, no raw palette). The Design ratchet only needs to stay ≤ the base-commit
  counts; new files at 0 keep it green.
- `eslint-rules/design/**` is expected to be **untouched**: the compact-hero rule is enforced by
  the existing SR-06/SR-07 one-spotlight count and the staging spec, not a new ESLint rule. If a
  lane does edit `eslint-rules/design/**`, the same PR commits `scripts/ci/pr-gate/baseline/
  design.json` equal to current counts (contract-change exception, `SPOTLIGHT_RULES.md` §C).
- No manifest archetype/route change: the five `dashboard` routes stay `archetype: "dashboard"`,
  `status: "migrated"`.

## Screens affected (verified in the manifest)

`archetype: "dashboard"` = `/health`, `/health/vitana-index`, `/wallet`, `/autopilot`,
`/autopilot/audiobook` (all `status: "migrated"`). `/autopilot/audiobook` renders through the
same My Journey / Autopilot dashboard surface; it inherits the change with no page-specific edit
unless its own hero differs — the lane confirms it shows one compact spotlight band and no
regression. "Health, Wallet, My Journey, Vitana Index" in the task map to `/health`, `/wallet`,
`/autopilot` (My Journey) and `/health/vitana-index`.

## Out of scope

Flipping the `desktop_spotlight` tenant default; any mobile, chrome, or non-`dashboard`
archetype change; new/changed dashboard data (SR-24 honesty kept); any live-system write.

## Verification summary

eslint `design/*` = 0 on changed files · Design ratchet green vs `origin/main` · `npm run build`
(tsc) · `npm test` (manifest, vtid-05111 composition, tier-b components, SpotlightLoading,
vtid-05105) · `npm run design:manifest` no drift · `npm run i18n:inventory` if strings change ·
LOCAL 1400×900 before/after desktop screenshots + a 390×844 mobile shot, all signed-out/mocked,
NO live systems. Ships behind `desktop_spotlight` (off by default), visible via `?spotlight=1`.
<!-- plan:end -->
