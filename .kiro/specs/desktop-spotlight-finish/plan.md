# Plan — desktop-spotlight-finish

Author: Kiro, session `kiro-202610152203-0347`, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (frontend only; no
backend, no migration, no gateway change). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.
The spec lives in `exafyltd/vitana-platform` (where PLAN-SPAR runs); all code, tests and `docs/validation/<VTID>/`
live in `exafyltd/vitana-v1`, and every lane `paths:` entry is a vitana-v1 path.

<!-- plan:begin -->
## Repos and pinned refs
This spec and its sparring live in `exafyltd/vitana-platform` (PLAN-SPAR runs only there). **Every code path, command
and baseline below is in `exafyltd/vitana-v1`**, pinned at
`exafyltd/vitana-v1@69d39ef344b578f1ff171e99c61295f51c4e1f50` (origin/main, 2026-10-21; re-checked from the earlier pin
1a553367f — the 1 commit between them touches none of the files below: `design.json`, the manifest, `gate.mjs`,
`lib.mjs`, `config.json`, `eslint.config.js`, `eslint-rules/design/**`, `PR-GATE.yml` and the skeleton building blocks
are byte-identical). This is the ref declared to the sparring partner via `spar_refs:` in `handoff.md`, so the partner
reads these files directly. vitana-platform carries no code change for this plan.

**Spar wiring note (2026-10-21).** `spar_refs:` only takes effect when the commit PLAN-SPAR checks out as its base
(`pull_request.base.sha`) already contains `parseSparRefs` (vitana-platform #4202). The PR base is now advanced to
`origin/main c74812569` (#4202 ancestor, `parseSparRefs` present), so the sparring partner reads the pinned vitana-v1
ref `69d39ef344b578f1ff171e99c61295f51c4e1f50` and can cite its files directly. The earlier `evidence_floor_not_met`
escalation was this wiring gap, not a plan defect (see `sparring/responses-2.md`); this note advances the plan text so
the session re-plans against the corrected base.

Premise paths, all in vitana-v1 at that ref:
- Earlier plan: `.kiro/specs/desktop-spotlight/{requirements,design,tasks,handoff}.md` + `lanes/`.
- Contract: `docs/design-system/SPOTLIGHT_RULES.md`. Manifest: `src/design/screen-manifest.json` (key `screens`,
  346 entries: 329 `migrated`, 17 `legacy`), test `src/design/screen-manifest.test.ts`, sync `npm run design:manifest`
  (`scripts/design/screen-manifest.mjs --sync`).
- Rules: `eslint-rules/design/{no-raw-palette,no-arbitrary-size,no-page-spinner,no-raw-content-card,
  no-physical-direction,require-screen-frame}.js`, all `error` in `eslint.config.js:215-220`; test
  `src/design/eslint-design-rules.test.ts`.
- Design ratchet: `scripts/ci/pr-gate/gate.mjs:100` (`ratchet-design <eslint-json> --base <sha> --head <sha>`),
  `gate.mjs:124` (`baseline-design <eslint-json>`); `scripts/ci/pr-gate/lib.mjs:112` (`countDesign`: severity-2
  `design/*` per file), `lib.mjs:132` (`chooseDesignBaseline`: BASE commit's baseline unless the PR changes
  `eslint-rules/design/**`); baseline `scripts/ci/pr-gate/baseline/design.json` (544 files, 3,705 errors at the ref);
  test `scripts/ci/pr-gate/__tests__/design-ratchet.test.mjs`; CI step "Design ratchet" `.github/workflows/PR-GATE.yml:150-153`
  (`id: design`, `continue-on-error: true`, runs `node scripts/ci/pr-gate/gate.mjs ratchet-design "$RUNNER_TEMP/eslint.json"
  --base "$BASE" --head "$HEAD"`), listed in the Verdict step's OUTCOMES as `design=${{ steps.design.outcome }}`
  (`PR-GATE.yml:166-179`, the `design=` line at `:177`); the step's pass text is `gate.mjs:122` ("✅ **design ratchet**
  (baseline: …) — no file gained design violations"), its fail text `gate.mjs:120` ("❌ **design ratchet** …").
- Skeleton building blocks: `src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx`, `VCardSkeleton` from
  `src/components/ui/vcard` (used at `src/components/community/spotlight/SocialStates.tsx:4`).
`exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs` is a different gate (no design check); the vitana-v1 gate
above is the one every lane's PR runs. **Partner readability:** this plan spans two repos, so it declares a companion
ref in `handoff.md` front matter — `spar_refs: exafyltd/vitana-v1: 69d39ef344b578f1ff171e99c61295f51c4e1f50` — and the
PLAN-SPAR session created for this PR reads that vitana-v1 commit directly, verifying every premise above. The
mechanism that forwards the ref is merged on vitana-platform `origin/main` (PR #4202, merge
`b74135485c2f1db7211e9371f60fd8c32358a5df`): `scripts/collab/plan-spar.mjs` `parseSparRefs()` reads `spar_refs:` from
the head checkout's `handoff.md`, `resolveRef()` returns a 40-hex SHA verbatim (no API call), and `step()` folds it into
`extra_refs` on `client.create()`; `.github/workflows/PLAN-SPAR.yml` runs plan-spar.mjs from the PR **base** checkout
(`pull_request_target`, base = `main`, which includes #4202) and supplies the `GITHUB_TOKEN` env for `resolveRef`. The
gateway validates each `extra_refs` key against `PLAN_SPARRING_REPOS` and the value against the SHA regex before merging
it into the session refs. No separate gate in this plan: the sparring session reads vitana-v1 and verifies these
premises, and the normal PLAN-SPAR approval path (converged → policy-approved) is the only gate before lanes get VTIDs.

## Goal
Finish the Spotlight desktop redesign (vitana-v1 `.kiro/specs/desktop-spotlight/`, VTID-05105 … 05117) to its
"System-wide done" state: every screen route `migrated` in vitana-v1 `src/design/screen-manifest.json` (except one
product question) and every non-chrome entry of vitana-v1 `scripts/ci/pr-gate/baseline/design.json` at 0. No change to
the design contract (`docs/design-system/SPOTLIGHT_RULES.md`): no new archetype, card size, token or ESLint rule, and
no change to `eslint-rules/design/**` (so every lane is measured against the BASE commit's baseline, `lib.mjs:132`).

## Measured state (vitana-v1 origin/main 5c4632ea9, 2026-10-16, `npx eslint src/pages src/components -f json`;
baseline and manifest totals re-checked unchanged at 704b5def4, 2026-10-18, and at 1a553367f, 2026-10-21:
`design.json` 544 files / 3,705 errors, manifest 346 = 329 `migrated` + 17 `legacy`)
- `design/no-raw-palette` 3,220 lines in 411 files (the handover's "~3,340"; batch 1 #1411 took 60 files to 0).
- `design/no-arbitrary-size` 359 lines in 208 files (420 values: 47 identical to a scale class, 38 within 2 px,
  335 to keep — 175 px > 2 px off, 113 vh/dvh, 13 %, 26 calc/vw/ch/min).
- `design/no-page-spinner` 27 in 24 page files.
- `design/no-raw-content-card` 50 / 50 files; `design/no-physical-direction` 32 / 16 files (18 in chrome);
  `design/require-screen-frame` 6 / 6 files.
- Total 3,694 errors in 541 files (`design.json` carries 3,705). Six sidebar/ORB chrome files hold 58 of them and stay
  (SR-01): `AppLayout`, `dev/DevSidebar`, `vitanaland/OrbDiscoveryHint`, `mobile/MobileBottomNav`,
  `mobile/SideDrawerNav`, `mobile/TopAppBar`.
- Manifest: 346 routes, 329 `migrated`, 17 `legacy`.

## Decisions (each decided by Kiro under owner delegation 2026-10-16)
The owner wrote on 2026-10-16: "you can decide yourself and move on, get the redesign of vitanaland desktop done".
1. **Raw palette colours** — decided by Kiro under owner delegation 2026-10-16: option A (owner 2026-10-14) — map each
   to the nearest existing token (SPOTLIGHT_RULES §E, extended in design.md §2), accept small shifts, no new tokens;
   continue from where batch 1 (#1411, 60 files) stopped. Literals that no token can carry without inverting contrast
   in one theme (media scrims, text on photos/video, third-party brand marks) keep the escape hatch with a reason.
2. **Arbitrary sizes** — decided by Kiro under owner delegation 2026-10-16: no new size tokens; identical Tailwind
   class where one exists; nearest class when the difference is ≤ 2 px; otherwise keep with
   `// design-allow-next-line: <reason>`.
3. **Page spinners → skeletons** — owner approved 2026-10-16 (after asking to see the mobile version too).
   `design/no-page-spinner` has **27 findings in 24 page files** (measured state). Those 24 files split into **19
   data-loading page files** and **5 action-in-progress files**; findings (27) exceed files (24) because three files
   carry two spinner sites each. The **19 data-loading page spinners** become skeletons on desktop (Spotlight) **and**
   on mobile, using the same `ArchetypeSkeleton` / `VCardSkeleton` shaped like each page's final layout — header and
   bottom nav stay, content cross-fades in, no layout shift. One shared `SpotlightLoading` (in
   `src/components/layout/spotlight/skeletons/`, built on the existing `ArchetypeSkeleton`, `VCardSkeleton` and shadcn
   `Skeleton`); no bespoke per-page skeletons. The **5 action-in-progress spinners** (`LiveRoomViewer`,
   `CreatorOnboarded`, `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess`) keep a spinner, each with a
   `design-allow-next-line: action in progress, not a data-load spinner` reason. These are action spinners (a
   submit/redeem/delete is running), **not** data-load spinners, so SR-20 (skeleton in the archetype's shape, which
   governs the initial data load) does not apply: each screen renders its migrated archetype immediately and only spins
   on the user-triggered action. They therefore stay `migrated` (layout/archetype compliant) and reaching the
   "every non-chrome entry at 0" goal is not in conflict with keeping the spinner — an allowed line is not counted by
   `countDesign` (`lib.mjs:112`; `ALLOW_RX` suppresses the report, `_shared.js:10`), so the file still reads `0` in
   `baseline-design`. **Lane ownership of the action-spinner pages:** `DeleteAccount`, `RedeemVoucher`,
   `TicketPurchaseSuccess` are owned solely by `remaining-screens` (the lane that also flips their archetype in
   Decision 4), which applies their allow reason in the same PR; `LiveRoomViewer` and `CreatorOnboarded` stay in
   `skeletons`. An MP4 (spinner before vs skeleton after, desktop and mobile) goes to the owner.
4. **Older open items** — decided by Kiro under owner delegation 2026-10-16: public profile `/u/:identifier` and
   `/me/profile` → `detail` (contract §A lists public profile under `detail`); `/redeem`, `/delete-account` → `form`;
   `/tickets/success`, `/tickets/demo` → `detail`; `/shop` → `immersive` inside the app shell (SR-04); Commerce portal →
   app shell for signed-in members on the app host on desktop Spotlight (the phone app already does this,
   VTID-03999), standalone for guests and `commerce.vitanaland.com`, no new step/field/dialog, PR carries "UX
   acceptance"; pure redirect components leave the manifest. `/business/sell-earn` stays unchanged — who may see it is
   a product question → open owner item.
5. **`desktop_spotlight` production flag** — decided by Kiro under owner delegation 2026-10-16: unchanged, no flag
   flip; it is an owner/production decision → open owner item.
6. **File ownership** (Kiro, within the plan): every file with findings belongs to exactly one lane, and that lane
   clears every `design/*` rule in it, so no two PRs edit one file. In particular the three action-spinner pages that
   Decision 4 also re-archetypes — `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` — belong only to
   `remaining-screens` (archetype flip and action-spinner allow reason in one PR), never also to `skeletons`. Shared:
   the two ratchet baselines (every lane) and `docs/SCREEN_INVENTORY.md` (the three lanes that add copy, each in its
   own new i18n shard).
7. **Raw `Card` and physical directions** (Kiro, within the contract): content items → `VCard`, panels → `Panel`
   (identical DOM); logical properties, centring/slide/sheet-direction cases keep the escape hatch.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat)
| Lane | Seat → reviewer | Scope (files with findings) | depends_on |
|---|---|---|---|
| `skeletons` | exafyltd → hotmail | `SpotlightLoading` + 19 data-loading spinner pages → skeletons + 2 action-spinner pages kept (`LiveRoomViewer`, `CreatorOnboarded`) | — |
| `public-profile` | exafyltd → hotmail | `src/components/profile/**` + 3 profile pages (67) | skeletons |
| `commerce-shell` | exafyltd → hotmail | commerce components/pages, `ShopFeed`, `UniversalCart`, portal login (28) | — |
| `remaining-screens` | exafyltd → hotmail | redeem, tickets, delete-account (sole owner of `DeleteAccount`/`RedeemVoucher`/`TicketPurchaseSuccess`: archetype flip + action-spinner allow reason), phone fallbacks, tickets/voucher components (17) + manifest generator/test, design-contract spec | skeletons, public-profile, commerce-shell |
| `colours-batch-2` | exafyltd → hotmail | health, journey, supplements, diary, memory (86) | — |
| `colours-batch-3` | exafyltd → hotmail | community, sharing, event game, live rooms, meetups, events, crossover, feed, home (81) | — |
| `colours-batch-4` | exafyltd → hotmail | discover, wallet, payment, calendar, business, reseller, orders, subscription, intents (96) | — |
| `colours-batch-5` | exafyltd → hotmail | shared popups, settings, AI, dev, admin, messages, onboarding (85, explicit list) | — |
| `colours-backoffice` | jtadic → exafyltd | 3 BackOffice dialogs (area `backoffice`) | — |
| `sizes` | exafyltd → hotmail | 52 files with size/card/direction findings and no palette finding | — |
Exact `paths` globs are in each `lanes/<id>.md`; a self-check over the ESLint report found 0 files in two lanes and 0
files outside every lane (chrome excepted). Eight lanes can run in parallel; `public-profile` waits for `skeletons`,
`remaining-screens` goes last.

## Test plan
- Per lane, all in vitana-v1: `npm test` (= `vitest run`, incl. `src/design/screen-manifest.test.ts`, the
  nav-registry tests and the new unit tests named in `tasks.md`), `npm run build`, `npm run lint`. Design ratchet
  locally before push: `npx eslint . -f json -o $TMP/eslint.json` then
  `node scripts/ci/pr-gate/gate.mjs ratchet-design $TMP/eslint.json --base origin/main --head HEAD` → "no file gained
  design violations"; then `node scripts/ci/pr-gate/gate.mjs baseline-design $TMP/eslint.json` and commit
  `scripts/ci/pr-gate/baseline/design.json` with only the lane's own files lowered (any other file's line changing
  in that diff is a lane-scope error). Same for `ratchet-eslint` / `baseline-eslint` (`baseline/eslint.json`).
  **Per-lane zero assertion (not just "ratchet passed"):** the ratchet only proves no file *gained* violations, never
  the plan's done-criterion "every non-chrome entry at 0", and PR-GATE is `enforce:false`, so the done check is
  explicit and machine-checkable per lane — after `baseline-design`, the lane asserts that **every file it owns**
  (its `paths` globs, chrome excepted) reads `0` or is absent in the regenerated `baseline/design.json` (grep the
  lane's files out of the committed baseline and assert each is absent/0). This assertion is part of the lane's own
  verification step and its result (0 for every owned file) is what the reviewer records — not merely the repo-wide
  `✅ design ratchet` total line.
- **PR-GATE is report-only.** vitana-v1 `scripts/ci/pr-gate/config.json:2` has `"enforce": false`, so the
  "Design ratchet" step (`PR-GATE.yml:150-153`, `continue-on-error`) only reports; the Verdict step
  (`PR-GATE.yml:166-190`: OUTCOMES incl. `design=` at `:177`, `FAILED` list at `:181`, `enforce` read at `:182`,
  report-only branch at `:189-190`) prints "would fail: design …" instead of failing. This plan does not flip `enforce` (the
  owner's kill switch). Instead the done criterion is explicit: a lane PR is not marked ready, and its reviewer seat
  does not pass it, unless that PR's PR-GATE summary shows "✅ design ratchet" and `design`, `eslint`, `tsc`,
  `scope` and `build` are absent from any "would fail" line. The reviewer records that line in the review.
- Staging: once CI assigns the VTIDs, each lane adds `docs/validation/<VTID>/staging-tests.json` naming its read-only
  spec `tests/e2e/staging/vtid-<VTID>-<lane>.staging.spec.ts` (1440×900 with `?spotlight=1`, and 390×844; sign in,
  navigate, read; network guard aborts every non-GET except sign-in; never `vitanaland.com`). STAGING-VERIFY on the
  merge commit is the done criterion; `design-contract.staging.spec.ts` covers every route flipped to `migrated`.
- Skeletons: Vitest desktop and mobile branches (skeleton, `aria-busy`, no spinner) and the 5 kept action spinners;
  staging spec with delayed GETs asserts the skeleton and no page spinner at both 1400×900 (`?spotlight=1`) and
  390×844 (app bar and bottom nav visible), CLS < 0.1 at both; MP4 `docs/validation/<VTID>/spinner-vs-skeleton.mp4`
  (desktop and mobile, before/after).
- Colour shifts: listed by category in each PR body with 1440 light/dark and 390 screenshots for Gate 2.
- Commerce: "UX acceptance" section in the PR; friction unchanged.
- No What's New entry (redesign of existing screens). No new routes, so no nav-registry or native parity ledger change.

## Open owner items (not decided here)
`desktop_spotlight` in production; `/business/sell-earn` visibility for non-resellers; I18N-PROPAGATE stale-write bug
(own plan); the three failing STAGING-VERIFY suites of the earlier plan (VTID-05111/05117, branch
`kiro/desktop-spotlight/staging-fix-forward`); an admin-role staging test account; removal of the Spotlight-off code
paths (separate sparred plan).
<!-- plan:end -->
