# Tasks — sidebar-chrome-colour-tokens
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR. One lane, in `exafyltd/vitana-v1`.

<!-- lane: chrome-colour-tokens -->
## chrome-colour-tokens — `text-slate-400` → `text-muted-foreground` (AppLayout.tsx:186), `bg-red-500` → `bg-status-error` (TopAppBar.tsx:111)
- [ ] T1. Red: add `src/components/chrome-colour-tokens.test.tsx` (plan.md "Tests and commands"). It renders
  `TopAppBar` and `AppLayout` (modules mocked, `isExafyAdmin: true`, sidebar open, desktop), LTR and `dir="rtl"`, and
  asserts no `RAW_PALETTE_SRC` class in the top app bar `header` and in `[data-sidebar="header"]`, plus the two target
  tokens on the two elements. Commit it alone and record the failing run in `docs/validation/<VTID>/commands.log`.
- [ ] T2. Green: `src/components/AppLayout.tsx:186` `text-slate-400` → `text-muted-foreground`;
  `src/components/mobile/TopAppBar.tsx:111` `bg-red-500` → `bg-status-error`. No other edit in either file.
- [ ] T3. Checks: `npx vitest run src/components/chrome-colour-tokens.test.tsx`; `npx vitest run src/components
  src/design`; `npm run lint`; `npm run test:design-contract`; `npm run design:manifest` (no diff);
  `node scripts/ci/pr-gate/gate.mjs weakening --base origin/main --head HEAD`. Log each in `commands.log`.
- [ ] T4. Screenshots (local dev, every Supabase/gateway request mocked or aborted, never production): sidebar header
  at 1400x900 and mobile top app bar at 390x844, light and dark, plus one RTL capture each, under
  `docs/validation/<VTID>/screenshots/`.
- [ ] T5. `docs/validation/<VTID>/staging-tests.json` (`service: community-app`, three `kind: playwright` entries for
  the existing specs of VTID-05286, VTID-05287, VTID-05289), `acceptance.md`, `commands.log`, `scope.json`.

Acceptance:
- Change types: UI (colour classes only).
- Outcome: the exafy-admin shield in the sidebar header uses `text-muted-foreground`; the LIVE dot in the mobile top
  app bar uses `bg-status-error`. Nothing else in either component changes.
- States: sidebar open with exafy admin (shield shown), sidebar collapsed (shield not rendered, unchanged); LIVE badge
  shown (outside a live room), hidden (inside a live room, unchanged).
- Surfaces: desktop sidebar (≥ md) and mobile top app bar (< md).
- Themes: light and dark use each token's own value (`src/index.css`).
- RTL: no directional class touched; the Vitest RTL render passes and the RTL screenshots look the same mirrored.
- Accessibility: no text or contrast regression; the shield stays decorative, the LIVE label is text.
- Proof: STAGING-VERIFY green for suites VTID-05286, VTID-05287 and VTID-05289 on the merge commit.
