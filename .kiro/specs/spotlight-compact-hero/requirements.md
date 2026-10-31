# Requirements: spotlight-compact-hero

## Goal

On the desktop `dashboard` archetype, the single Spotlight card is far too big. Today it takes the full
760 px stage width and most of the stage height. The fix is to keep it a real Spotlight card at a
proportionate size, inside a denser bento grid.

The owner approved "approved blend v2" (owner correction, 2026-10-31). The reference mock is
`vitana-v1/.agents/tasks/spotlight-card-resize/approved-blend-v2.png`; it shows intent only and is not
shipped. Earlier explorations: `option-a.png`, `option-b.png`, `options.md`.

Scope:
- Desktop Spotlight content area only.
- Chrome, mobile and RTL behaviour stay as they are.
- The change sits behind the existing `desktop_spotlight` tenant flag (off by default, previewable with
  `?spotlight=1`).

## Functional requirements

### R1: Contract rule (in `docs/design-system/SPOTLIGHT_RULES.md`)

- There is exactly one Spotlight VCard per screen.
- On `dashboard` it keeps its Spotlight identity:
  - gradient artwork media in the contract 16:9 ratio;
  - an accent border/ring;
  - raised elevation;
  - its primary content: Vitana Index ring, headline, "+N this week", one-line insight.
- It is the most prominent tile but never dominates:
  - it sits at the top-start of the grid;
  - it is about 40% of the stage width (at most 45%) and about 2 grid rows tall;
  - it is never full width;
  - it covers at most about 45% of the first-viewport stage area.
- Other `standard` cards fill the grid around it.
- Update the §A archetype table and the §B dominance rules. SR-11 gets an exception for this card's two
  rows. SR-06, SR-07 and SR-10 are kept.

### R2: Every dashboard screen

- The change is built once, in shared components (`src/components/spotlight/tier-b/**` and
  `JourneySpotlight.tsx`), and used by all four page files.
- That covers `/health`, `/health/vitana-index`, `/wallet`, `/autopilot` and `/autopilot/audiobook`.
- No screen regresses.

### R3: Width and rail

- The `dashboard` stage width becomes `full`, an existing width token, so the grid fills a 1920×1080
  viewport with no large empty band at the bottom.
- My Journey's `JourneyRail` folds into the grid as tiles, with its handlers kept.
- No rail remains on `dashboard`.

### R4: Quick actions

- Quick actions are one strip of compact pill buttons, not large tiles.
- Each pill uses an existing handler.
- No control is dropped. For example, Wallet's `CurrencyToggle` stays in the Spotlight card.

### R5: Skeleton parity

- `ArchetypeSkeleton` for `dashboard` mirrors the bento shape: a spotlight skeleton at 40% × 2 rows,
  `standard` skeletons, and a pill-strip row.
- CLS stays below 0.1 (SR-20/21).

### R6: Lint and ratchet

- `design/*` reports 0 errors on every changed file.
- The Design ratchet is green against `origin/main`.
- If `eslint-rules/design/**` changes, commit a `design.json` baseline equal to the current counts.

### R7: Tokens, honesty and RTL

- Existing design tokens only. Any new token is flagged to the owner rather than invented; this applies
  to the optional coloured glow.
- No raw palette and no `h-[…]`/`w-[…]` sizes.
- Logical start/end properties only, so the card sits top-right in RTL.
- Tiles show only data the page already loads. Nothing is fabricated (SR-24).

### R8: Verification and no live writes

- Verification is local and read-only only:
  - Vitest;
  - the build;
  - a read-only staging proportion spec, run locally against `npm run preview`;
  - local screenshots.
- There are no writes to staging, production, the gateway or Supabase.

## Non-goals

- Flipping the `desktop_spotlight` default.
- Mobile changes.
- Chrome changes: sidebar, shortcut bar, top bar, utility tabs, ORB and theme.
- Changes to non-`dashboard` archetypes.
- New dashboard data.
