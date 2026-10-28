# Requirements — spotlight-compact-hero

Compact the oversized Spotlight hero on the desktop `dashboard` archetype and add a denser
bento grid of medium cards below it, as a **design-contract change** to `dashboard`. Owner
approved the BLEND of the two reviewed mocks (compact hero like OPTION A on top + denser
bento grid like OPTION B below). Desktop Spotlight content-area only; chrome, mobile and RTL
unchanged.

Base mocks the owner approved (intent only, not shipped):
`vitana-v1/.agents/tasks/spotlight-card-resize/{option-a.png,option-b.png,options.md}`.

## Context (verified in code)

- The `dashboard` archetype uses width `stage-rail` but **none of the five dashboard pages
  passes a `rail`** to `ScreenFrame` — they render a single centred stage column (Tier B, no
  stage/rail re-layout). Verified: `Health.tsx:442`, `Wallet.tsx:546`,
  `health/VitanaIndexDetail.tsx:650`, `AutopilotDashboard.tsx:484` all pass only `children`,
  no `rail`. `SpotlightLayout` only renders a rail when `width==='stage-rail' && rail != null`
  (`SpotlightLayout.tsx:38`) and the CSS only widens for `.sp-grid:has(> .sp-rail)`
  (`src/index.css:443`). The "Up Next rail" in the mocks therefore has no real counterpart on
  these screens.
- The "dinosaur" is the hero `spotlight` VCard: full stage width (`--sp-stage-max: 760px`,
  `src/index.css:188`) with a 16:9 media box (`VCard.tsx` `mediaBoxClass` → `aspect-video
  w-full`) plus a tall body (pillar list / action rows). `VitanaIndexHeroCard`
  (`src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx`) is the shared hero of Health and
  Vitana Index; Wallet and My Journey build their own `size="spotlight"` VCard inline.
- Contract constraints that MUST survive: **SR-06** (dashboard shows exactly one `spotlight`
  VCard in the first viewport), **SR-07** (nothing else uses `spotlight`), **SR-12** (no fixed
  pixel heights, no card-in-card), **SR-14** (width tokens only), **SR-16** (fixed type
  scale), **SR-17/18** (tokens only), **SR-19** (logical props / RTL), **SR-20/21** (archetype
  skeleton mirrors the shape, CLS < 0.1).
- Enforcement that MUST stay green: the ESLint `design/*` rules at error level
  (`eslint-rules/design/*`), the base-branch **Design ratchet** (`scripts/ci/pr-gate/baseline/
  design.json`), the manifest test (`src/design/screen-manifest.test.ts`), the Tier B
  composition test (`src/pages/spotlight-tier-b.vtid-05111.test.tsx` — asserts each dashboard
  page contains one `size="spotlight"` / `<VitanaIndexHeroCard`), and the staging design-lint
  (`tests/e2e/staging/design-contract.staging.spec.ts`, plus `vtid-05111-tier-b`).
- Flag: the whole Spotlight desktop layout is behind the tenant flag `desktop_spotlight` (off
  by default), previewable with `?spotlight=1` (`useSpotlightEnabled`). This change rides that
  flag; flipping the tenant default stays the owner's call.

## Functional requirements

- **R1 — Contract.** Update `docs/design-system/SPOTLIGHT_RULES.md` so the `dashboard`
  archetype defines (a) a COMPACT hero presentation of the single `spotlight` VCard — a short
  horizontal band, ~1/3 of today's hero height, no 16:9 media block, small inline Index ring +
  headline + "+N this week" + one-line insight — and (b) a bento grid of `standard` VCards
  below it where no tile exceeds ~40% of the stage width. SR-06/SR-07 stay: still exactly one
  `spotlight` card. Add the rule text and update the archetype table row. If and only if the
  compact band cannot be expressed with existing tokens, a new size token is flagged in
  `plan.md` as an explicit contract addition for the owner — it is NOT invented silently.
- **R2 — Shared component.** The compact hero + bento grid is implemented once in a shared
  place (`src/components/spotlight/tier-b/`) and adopted by every `dashboard` page so Health,
  Vitana Index, Wallet and My Journey all get it — not a one-off on Health. No page regresses.
- **R3 — Skeleton parity.** `ArchetypeSkeleton` and `SpotlightLoading` for `dashboard` mirror
  the new compact-hero + bento shape (compact band + grid), so there is no layout shift when
  content arrives (SR-20/21, CLS < 0.1).
- **R4 — ESLint + ratchet.** `design/*` = 0 on every changed file; the Design ratchet is green
  vs `origin/main`. Because this PR touches `eslint-rules/design/**` only if the contract's
  enforceable rules change, a baseline equal to current counts is committed in that case.
- **R5 — Rail decision.** Fold "Up Next" into the bento grid as a `standard` tile; keep no
  rail (there is none to keep on these pages). Recorded in `plan.md`.
- **R6 — Tokens / RTL.** Existing design tokens only; no raw palette, no `h-[…]`/`w-[…]`;
  logical `start`/`end` only.
- **R7 — No live writes.** Verification is local (vite build + preview + Playwright,
  signed-out / mocked) and Vitest/unit only. No staging/production/gateway/Supabase writes.

## Non-goals

- Flipping the `desktop_spotlight` tenant default (owner's call).
- Any change to mobile layout, the sidebar/shortcut bar, top bar, utility tabs, ORB, dark
  theme, or any non-`dashboard` archetype.
- Changing what data the dashboards show (no new KPIs invented; honesty rule SR-24 stays).
