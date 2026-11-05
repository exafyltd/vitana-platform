# Tasks — media-hub-vitana-cards
<!-- lane: media-hub-cards -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T1 Baseline: on `origin/main` run `npx vitest run src/components/media` and save the output to
      `docs/validation/<VTID>/outputs/vitest-base.txt`. It must be green.
- [ ] T2 In `src/pages/community/MediaHub.tsx` delete the `EnrichmentCardStrip` import (line 2) and the mount with its
      comment (lines 874-875). No other line changes (plan § Change 1).
- [ ] T3 Add `tests/e2e/staging/media-hub-vitana-cards.staging.spec.ts` (plan § Change 2): `import { test, expect } from
      './staging-guard'`; read-only; signs in with `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (skip when unset); on
      390×844 and 1400×900 opens `/comm/media-hub`, waits for the Shorts tab, asserts no `card-[EFGB]\d+` test id and no
      "See matches" / "People who match you" text. List it with `npx playwright test --list tests/e2e/staging/media-hub-vitana-cards.staging.spec.ts`.
- [ ] T4 Green on head: `npx tsc --noEmit -p tsconfig.app.json` error count unchanged (176) with none in
      `MediaHub.tsx`; `npx vitest run src/components/media` green. Commands and summaries in `docs/validation/<VTID>/commands.log`.
- [ ] T5 `docs/validation/<VTID>/staging-tests.json` (UTF-8, no BOM): `service: community-app`, tests: one
      `kind: "playwright"`, `spec: tests/e2e/staging/media-hub-vitana-cards.staging.spec.ts`, `cwd: "."`; one
      `kind: "existing"`, `ref: "npx vitest run src/components/media"`, `cwd: "."`, reason "the Media Hub screen and
      its spotlight layout keep their existing behaviour".
- [ ] T6 PR titled `VTID-xxxxx (media-hub-vitana-cards/media-hub-cards): …`; its head is green in PR-GATE and the
      staging deploy of the merge commit passes STAGING-VERIFY, including the playwright spec.

Acceptance:
- Change types: UI (one page, plus a staging spec and validation records).
- **Outcome** — a member opening Media Hub on the phone or on desktop sees no Vitana recommendation card above the
  Shorts / Music / Podcasts tabs. Search, the tabs, upload and the feed work as before.
- **States** — empty, loading, error and slow responses of the Media Hub feed are unchanged: the card strip had its own
  loading and empty behaviour, which disappears with it. Nothing new is shown in its place.
- **Surfaces** — phone: `src/pages/community/MediaHub.tsx` (the `isMobile` branch of the same render path); desktop: the
  same file (legacy layout). `MediaHubSpotlight.tsx` does not render the strip, so no change there. Redirect
  `/community/media-hub` → `/comm/media-hub` is unchanged.
- **Locales** — n/a: no new text. The removed strip uses translated card titles that are no longer shown; locale files
  are unchanged.
- **Accessibility** — n/a for new UI. Removing the strip removes its dismiss buttons from the tab order; the tab order
  of the remaining controls is unchanged. Focus order stays: Search, Shorts, Calendar, upload, tabs.
- **Contract** — n/a: no request, response or gateway change. The `community` screen request stops being sent from
  this page; `src/components/vitana/EnrichmentCardStrip.tsx` and the gateway catalog are unchanged.
- **Staging proof** — the playwright spec asserts, on the deployed staging build at phone and desktop size, that no
  Vitana card test id and no "See matches" / "People who match you" text renders on `/comm/media-hub` after the Shorts
  tab is visible. If the test account is not provided, the spec skips and the lane log says "not verified on staging:
  test account not provided".
- Red on base for the reason fixed: n/a (a removal; the base assertion is the card's presence, shown by the browser
  screenshots of the change in `docs/validation/<VTID>/outputs/`). Green on head; diff only inside the lane `paths`;
  no test skipped or loosened; files UTF-8 without BOM.
