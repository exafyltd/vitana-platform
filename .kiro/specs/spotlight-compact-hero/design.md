# Design: spotlight-compact-hero (approved blend v2)

All `file:line` references are into `exafyltd/vitana-v1` `origin/main` at `847a9f68`.
`plan.md` (D1–D7) is the source of truth; this file explains the geometry and the reasoning.

## 1. Why the card is "a dinosaur" today

- `ARCHETYPE_WIDTH.dashboard = 'stage-rail'` (`src/components/layout/spotlight/archetypes.ts:28`)
  puts the stage in one centred column capped at `--sp-stage-max: 760px`
  (`src/index.css:188`, `.sp-grid` at :426).
- Inside that column the Spotlight VCard spans the full width and stacks a tall body.
- The rest of a 1920 px viewport is left empty.
- A smaller card inside a 760 px column cannot reach the owner's proportion: it would be either tiny or
  still full width. So the archetype needs a wider stage.

## 2. Width: `full` (existing token)

- `.sp-layout[data-width="full"] .sp-grid { grid-template-columns: minmax(0, 1fr) }`
  (`src/index.css:436-437`) is already in the contract (SR-14).
- `SpotlightLayout` renders a rail only for `stage-rail` (`SpotlightLayout.tsx:34`), so `full` has
  no rail.
- My Journey's `JourneyRail` (`AutopilotDashboard.tsx:508`, `JourneySpotlight.tsx:116`) folds into
  the grid as tiles with the same props and handlers.

## 3. Bento geometry

Layout at `xl` and above, matching the v2 mock:

```
grid grid-cols-10 gap-4
┌───────── col-span-4 row-span-2 ─────────┬── col-span-3 ──┬── col-span-3 ──┐
│ SPOTLIGHT (gradient art 16:9 + ring,     │ tile           │ tile           │
│ +N pill; eyebrow, headline, insight)     ├────────────────┼────────────────┤
│                                          │ tile           │ tile           │
├── col-span-2 ──┬──── col-span-4 ────┬── col-span-2 ──┬── col-span-2 ──┤
│ tile           │ tile (list)        │ tile           │ tile           │
└────────────────┴────────────────────┴────────────────┴────────────────┘
QUICK ACTIONS  ( pill ) ( pill ) ( pill ) ( pill )        ← full-width strip, not a VCard
long-form TierBSection blocks (full width)
```

- The Spotlight card takes 4 of 10 columns, so it is 40% of the stage width, and spans 2 rows.
- No `standard` tile is wider than the Spotlight card.
- Every row adds up to 10 columns (SR-13).
- `row-span-2` stretches the four neighbours to the card's height, so no row has holes.
- Below `xl` the grid falls back to the `TIER_B_GRID` columns (`TierBKit.tsx:18`).
- Only default Tailwind grid utilities are used. `tailwind.config.ts` does not override them.
- No `h-[…]`/`w-[…]` sizes (SR-12/14).

## 4. Spotlight identity with existing tokens

The card stays a `<VCard size="spotlight">`, so every one-spotlight check still holds:

- `design-contract.staging.spec.ts`, the `SINGLE` block;
- `vtid-05111-tier-b.staging.spec.ts`;
- `spotlight-tier-b.vtid-05111.test.tsx:222-227`.

Its parts:

- **Media:** a `mediaSlot` with token gradient artwork (for example `from-status-success/30
  to-status-info/30`, the §E Vitana Index ring mapping, or `category-*`) in the 16:9 box
  (`VCard.tsx` `aspect-video`). The Vitana Index ring and the "+N this week" pill sit on top of it.
- **Body:** eyebrow, headline, one-line insight.
- **Accent:** `shadow-vcard-raised` (`tailwind.config.ts:272`), `border-primary/50` and
  `ring-1 ring-primary/30`. Standard tiles use `shadow-vcard`.

**Flagged for the owner:** a true coloured glow would need a new elevation token, because only the
neutral `--sp-elevation-1/2` exist (`src/index.css:195-196`). The plan ships without it.

## 5. Data honesty (SR-24/25/26)

- Tiles use only hooks each page already calls. For Health that is `useVitanaIndexCache()`
  (total, trend, five pillar scores), `useAutopilot()` (pending count, latest actions),
  `NextBestActionCard`, and the pillar agents.
- The mock's figures are illustrative, not data.
- A tile with no data shows the shared empty state or is left out, and the row is rebalanced so it
  stays full.
- Quick-action pills reuse existing handlers. Wallet keeps `CurrencyToggle` in the card body
  (`Wallet.tsx:581`) and moves its secondary actions into pills, with the same `isIAPRestricted()`
  guards.

## 6. Skeletons (SR-20/21)

- The `dashboard` case of `ArchetypeSkeleton` (`ArchetypeSkeleton.tsx:39`) mirrors the same
  10-column bento.
- `VCardSkeleton size="spotlight"` already carries the 16:9 box (`VCardSkeleton.tsx`). It sits at
  `col-span-4 row-span-2`, with `standard` skeletons in the D4 spans and a pill-strip skeleton row.
- The mobile `MobileShape` (`SpotlightLoading.tsx:59`) is unchanged.

## 7. Enforcement and verification

- New read-only staging spec `spotlight-dashboard-proportion.staging.spec.ts`. It runs at 1440×900
  and 1920×1080, plus RTL, and checks:
  - exactly one spotlight card;
  - its width relative to the stage is between 0.30 and 0.45, and it is not full width;
  - its area is at most 0.45 of the first-viewport stage area;
  - it sits at the inline start;
  - there is no horizontal scroll and no empty band larger than 25% of the viewport.

  The spec also runs locally against `npm run preview`.
- Vitest checks the card's identity (media box, accent classes), the composition (`/autopilot` added,
  `<JourneyHero` and `<DashboardSpotlight` counted, `DASHBOARD_BENTO` used, no `rail=`), and the
  folded rail's handlers.
- `eslint-rules/design/**` is untouched, so `design.json` keeps its base counts.
