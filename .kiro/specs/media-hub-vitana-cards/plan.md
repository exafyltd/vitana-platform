---
change_class: standard
---
# plan(media-hub-vitana-cards): remove the Vitana card strip from the Media Hub screen
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611031037-633b` (Kiro Web, owner task 2026-11-03). Code repo:
`exafyltd/vitana-v1`; the spec lives in vitana-platform because PLAN-SPAR only runs here. Premises pinned to vitana-v1
`origin/main` `6b9137ac5` and vitana-platform `origin/main` `814b585220`. Detail: `tasks.md`; lane file under `lanes/`.
<!-- plan:begin -->
## Goal
Owner quote: "Remove these Vitana cards completely from the Media Hub screen" (screenshot of the phone Media Hub
showing the Vitana "People who match you / See matches" card, with a second card partly visible on the right edge).
After this change the Media Hub (`/comm/media-hub`) shows no Vitana recommendation cards, on phone and desktop.
Everything else on the screen (search, Shorts / Music / Podcasts tabs, upload, the feed) stays as it is.

## Today (evidence, read-only, vitana-v1 `origin/main` `6b9137ac5`)
1. `src/pages/community/MediaHub.tsx:2` imports `EnrichmentCardStrip` from `@/components/vitana/EnrichmentCardStrip`.
2. `src/pages/community/MediaHub.tsx:874-875` mounts it as the only Vitana card surface on the page:
   `<EnrichmentCardStrip screen="community" layout="carousel" className={isMobile ? "mt-2 mb-2" : "mb-4"} />`
   (comment "VTID-05086: Unified Card System — carousel at the top"). The strip asks the gateway for the `community`
   screen's cards and renders them. The mount sits in the shared render path, so it appears on both phone and desktop.
3. The desktop Spotlight layout (`src/components/media/spotlight/MediaHubSpotlight.tsx`) does not render the strip, and
   `MediaHub.tsx` is the only file that mounts `EnrichmentCardStrip` with `screen="community"`.
4. Existing tests that touch the Media Hub: `src/components/media/spotlight/MediaHubSpotlight.vtid-05110.test.tsx`
   (13 tests) and `src/components/media/**` (19 tests in total), all green on `6b9137ac5`. No test asserts the strip on
   this screen.
5. The staging spec pattern for an authenticated screen is `tests/e2e/staging/vtid-05330-profile-posts-full-width.staging.spec.ts`
   (sign-in with `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`, read-only via `./staging-guard`).

## Premises, checked in `exafyltd/vitana-v1` at `6b9137ac5` (sparring round 1, R1-F1)
Checked with `git show origin/main:<path>` and `grep` on that commit:
- `src/pages/community/MediaHub.tsx:2` → `import { EnrichmentCardStrip } from "@/components/vitana/EnrichmentCardStrip";`
- `src/pages/community/MediaHub.tsx:875` → `<EnrichmentCardStrip screen="community" layout="carousel" className={isMobile ? "mt-2 mb-2" : "mb-4"} />`
- `src/components/media/spotlight/MediaHubSpotlight.tsx` contains no `EnrichmentCardStrip`.
- `src/components/vitana/EnrichmentCardStrip.tsx` exists and is the only definition of the strip.
- The route `/comm/media-hub` is `src/App.tsx:1263` → `MediaHub`.

## Repo of each change (sparring R1-F4)
- **Change 1 — repo `exafyltd/vitana-v1`:** the file edit in `MediaHub.tsx`.
- **Change 2 — repo `exafyltd/vitana-v1`:** the staging spec goes in `tests/e2e/staging/`, the folder the vitana-v1
  staging specs use (for example `tests/e2e/staging/smoke.staging.spec.ts`). Its `./staging-guard` import is copied in by
  the STAGING-VERIFY runner, the same way the existing vitana-v1 specs use it.
- **Change 3 — repo `exafyltd/vitana-v1`:** the validation evidence goes in `docs/validation/<VTID>/` of vitana-v1.
- The plan spec itself lives in `exafyltd/vitana-platform`, because PLAN-SPAR only runs there. No product code changes there.

## Change
- **Change 1 (lane `media-hub-cards`, repo `exafyltd/vitana-v1`):** delete line 875 and the import on line 2 of `src/pages/community/MediaHub.tsx`.
  No other line changes. The gateway keeps generating the `community` cards; nothing else on the app requests them
  (`screen="community"` has one mount). Removing the server side is a separate follow-up, not part of this plan.
- **Change 2 (same lane):** a read-only staging spec `tests/e2e/staging/media-hub-vitana-cards.staging.spec.ts` that
  signs in, opens `/comm/media-hub` on phone (390×844) and desktop (1400×900), waits for the Shorts tab, and asserts
  that no Vitana card (`data-testid` matching `card-[EFGB]\d+`) and no "See matches" / "People who match you" text
  is on the page.
- **Change 3 (same lane):** `docs/validation/<VTID>/` evidence: `acceptance.md`, `commands.log`, `outputs/` (typecheck
  summary and the vitest run), `staging-tests.json` (one `playwright` test for Change 2 and one `existing` vitest run
  of `src/components/media`).

## Interfaces between lanes
One lane. No other lane reads or writes these files.

## Parallel, shared and hot files
One lane, so nothing runs in parallel. `src/pages/community/MediaHub.tsx` is not on the hot-file list (§8a item 4).
The staging spec is new and owned by this lane. No migration, no gateway change, no i18n change.

## Tests and commands
- Before the change: `npx vitest run src/components/media` green on `origin/main` (recorded in `outputs/`).
- After the change: `npx tsc --noEmit -p tsconfig.app.json` reports no new error in `MediaHub.tsx` (the repo already has
  176 unrelated type errors on `origin/main`; the count must stay 176). `npx vitest run src/components/media` green.
- STAGING-VERIFY: the playwright spec runs against the staging build after the merge; the vitest run is the `existing`
  entry. The staging build proves the outcome, not only the source change.

## Measurement
`docs/validation/<plan VTID>/timings.json` is written by the plan driver (collaboration.md §8b).

## Risks
- The gateway keeps producing `community` cards that nothing renders. Harmless; the follow-up removes them.
- The staging spec needs `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` in the staging-verify environment. Without them the
  test skips (as the other authenticated staging specs do), and the lane log then says "not verified on staging:
  test account not provided" rather than claiming the proof.
- A card that another screen renders with the same `card-*` test id would not be affected by this change, because the
  spec runs on `/comm/media-hub` only.

## Unchanged
Search, the Shorts / Music / Podcasts tabs, the upload menu, the feed, the Calendar and Inbox buttons, the desktop
Spotlight layout, the Vitana cards on Home, Profile, Autopilot and Make a Post, and the gateway card catalog.
<!-- plan:end -->
