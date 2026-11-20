# Plan — native-wave2-sharing-business
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.

<!-- plan:begin -->
## Goal
Wave 2 screen-port batch of the native Maxina app: port the sharing / distribution cluster and the business-hub
cluster — the 21 web destinations the parity ledger assigns to `"lane": "sharing-business"` — to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the
N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does **not** need G1 planned
or built to land the ports; every device-runtime verification step is marked depends-on-owner (G1). No redesign
(program §4), no new web screen, no `App.tsx` route, no registry/manifest change — only native route files and
parity-row status flips. The Commerce UX contract (`CLAUDE.md`, VTID-05204) governs the business-hub onboarding
surfaces.

## Measured state (origin/main of exafyltd/vitana-v1, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **21 rows** carry `"lane": "sharing-business"`, **all `status: "not_started"`** (19 `screen`, 2 `route`);
  **435 rows total**. Counted with `node -e` over the ledger JSON read from `origin/main`
  (`git show origin/main:apps/mobile/parity/ledger.json | node …`; the `--report` CLI needs `typescript`, not
  installed in this worktree). The 21 rows and their web paths are listed in `requirements.md` R0.2–R0.3, verbatim
  from the ledger.
- Web sources verified present on `origin/main` with line counts: `src/pages/Sharing.tsx` (137),
  `src/pages/sharing/Campaigns.tsx` (315), `src/pages/sharing/CampaignDetail.tsx` (473),
  `src/pages/sharing/Distribution.tsx` (696), `src/pages/sharing/DataConsent.tsx` (232), `src/pages/InviteFriends.tsx`,
  `src/pages/CreatorOnboarded.tsx`, `src/pages/PublicCampaignLanding.tsx`; `src/pages/BusinessHub.tsx` (689),
  `src/pages/BusinessOpportunities.tsx` (138), `src/pages/BusinessListings.tsx` (153); component libraries
  `src/components/sharing/**` (incl. `BlastCenter.tsx` 429, `ChannelConnector.tsx` 158, `UniversalShareDialog.tsx` 356,
  `AutomationRuleDialog.tsx` 111, `InstagramShareModal.tsx` with `html2canvas` at `:2,52`), `src/components/business/**`
  (ServicesSubTabs / ClientsSubTabs / SellAndEarnSubTabs / AnalyticsSubTabs) and `src/components/reseller/**`
  (ResellerAvailableEventsTab, ResellerCampaignsTab). Routes at `src/App.tsx:860` (`/pub/campaigns/:id`), `:1108-1112`
  (`/creator/onboarded`), `:1295-1306` (`/business` shell + nested tabs), `:1527-1536`
  (`/business/opportunities|listings`), `:1551-1556` (`/invite`), `:1579-1603` (`/sharing` + sub-pages). (Line counts
  are an **approximate** scoping snapshot; the load-bearing checks are the class-A/class-B closure facts below.)
- **Class-B coupling measured:** 10 of the `src/components/sharing/**` components import
  `@/integrations/supabase/client` (`ChannelConnector`, `InlineChannelConnector`, `BlastCenter`, `CampaignDialog`,
  `CreatePackageDialog`, `EditPackageDialog`, `CreatePostDialog`, `TemplateDialog`, `AutomationRuleDialog`,
  `UniversalShareDialog`), and `ChannelConnector` also imports `useChannels` — gateway/Supabase-coupled, so they are
  **class B** and re-implemented natively, not extracted (decision 3). The business pages fetch through hooks that are
  likewise class B.
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Two disjoint lanes by cluster.** The 21 `sharing-business` rows split along the ledger's own key prefixes: the 8
   non-`BUSINESS.` rows (all `SHARING.*`, `COMM.INVITE`, and the two public exclusion routes `/creator/onboarded`,
   `/pub/campaigns/:id`) form the **`sharing`** lane; the 13 `BUSINESS.*` rows form the **`business-hub`** lane. The
   two touch disjoint route files and component folders (`src/components/sharing/**` vs `src/components/business/**` +
   `src/components/reseller/**`), build/review independently, and each leaves the app buildable.
   **Partition: sharing 8 + business-hub 13 = 21** (0 overlap, 0 orphan). Each row named explicitly in its lane file.
2. **No cross-lane dependency — both `depends_on: []`, run fully in parallel.** Unlike the home-feed plan (where
   `home` depended on `news` for the `NewsArticleCard` twin), there is no shared native twin or core module one lane
   owns and the other consumes here: the sharing and business component trees are separate, and each lane adds only
   its own pure core re-exports.
3. **Class-A-only core extraction; class-B re-implemented natively** (requirements R1-B). Only pure, IO-free helpers
   (campaign status/kind mapping, channel-eligibility logic, schedule/audience formatting; `pathToMobileTab`, IO-free
   earnings/growth aggregation) move into `@vitana/core` — each via a `packages/core/manifest.json` line + a re-export
   in `packages/core/src/**` + `node scripts/native/core-closure.mjs --write` with the regenerated
   `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` committed in the **same
   lane PR**, so `--check` passes. The gateway/Supabase-coupled channel connectors, campaign hooks and business data
   hooks are class B (measured above) and would fail `core-closure.mjs --check` (`m.own !== 'A'`, `:153` — the ownership
   guard; the `for` loop over the sorted closure starts at `:150`, corrected per sparring R1-F1); each lane
   **re-implements their data access natively** (native Supabase client + native auth context — the home-feed plan's
   pattern for `useNewsFeed`/`useAllNewsFeed`) and consumes only the pure helpers from core. Type-only edges are
   excluded from the closure (`extraction-deps.mjs:183`) and resolved by the native `@/*` alias.
4. **html2canvas → React Native share-image** (requirements R1-C). The web share-card generation uses `html2canvas`
   (`InstagramShareModal.tsx:2,52`), which has no React Native equivalent; the native universal-share surface produces
   the same card image with `react-native-view-shot` (`captureRef`) or an equivalent native capture, feeding the OS
   share sheet. Flagged as a named port note; the image and flow match the web, only the capture mechanism differs.
5. **Commerce UX contract honoured by a 1:1 port** (requirements R2.5; `CLAUDE.md` VTID-05204). The business-hub
   onboarding surfaces are AI-led, one dominant action per screen, plain business language, progressive disclosure.
   Because this lane is a 1:1 port of the existing mobile-web business screens it reproduces the web flow exactly and
   adds no new field/step/dialog/status, so onboarding friction is **unchanged**. The business-hub PR carries the
   contract's "UX acceptance" section.
6. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`). The
   `?tab=…` business rows match the single `/business` route file by `shapeOf()` (query dropped), so one file
   satisfies every `BUSINESS.*?tab=` row — but each row's status is still flipped to `native` or the ledger reports
   the lane permanently incomplete.
7. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
8. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web
   defects are not reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `sharing` | exafyltd → hotmail | `SHARING.OVERVIEW /sharing`, `SHARING.CAMPAIGNS`, `SHARING.CAMPAIGN_DETAIL`, `SHARING.DISTRIBUTION`, `SHARING.DATA_CONSENT`, `COMM.INVITE /invite`, exclusion routes `/creator/onboarded` + `/pub/campaigns/:id`; composes `src/components/sharing/**`; html2canvas→RN share-image (**8 rows**) | — |
| `business-hub` | exafyltd → hotmail | `/business` shell (`BUSINESS.OVERVIEW` + the 4 nested tabs `services`/`clients`/`sell-earn`/`analytics` + the 6 `?tab=services.*|sales.*|insights.*` rows), `BUSINESS.OPPORTUNITIES`, `BUSINESS.LISTINGS`; composes `src/components/business/**` + `src/components/reseller/**`; Commerce UX contract (**13 rows**) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 21 parity rows partition **8 (sharing) + 13 (business-hub)** with
0 overlap and 0 orphan. The `?tab=…` business rows are dedicated ledger rows the business-hub lane flips to `native`
(exact `shapeOf` match against the single `/business` file — `parity-ledger.mjs:60`). Both lanes have no deps and run
in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; sharing: campaign list/detail, distribution/scheduled, channel
  connect state, universal share dialog + `captureRef` invoked, data-consent, invite, both public landings;
  business-hub: shell per tab + `?tab=` variants, opportunities/listings, reseller tabs + earnings; i18n no-raw-text +
  RTL start/end; `pt` Brazilian você-form; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (R1-B): run `--write` AND commit the generated files, not just `--check`.** The lane
  PR that adds class-A re-export entries to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json` and
  `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then `--check` passes. The class-B channel
  connectors / campaign hooks / business data hooks are NOT extracted — re-implemented natively.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; `pt`
  Brazilian você-form; RTL (`ar`) rendered per screen (start/end only).
- **Commerce UX (business-hub):** the PR carries the "UX acceptance" section — user steps · required fields ·
  decisions · anything askable-but-inferable ("none — 1:1 port") · next-step clarity · friction vs web ("unchanged").
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<cluster>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- The native share-image library — `react-native-view-shot` vs an equivalent native capture (decision 4 default:
  `react-native-view-shot`); a one-line dependency choice, not a scope change.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
<!-- plan:end -->

<!-- re-trigger after PLAN-SPAR repair; 2026-10-28T09:53:47.0048272+01:00 -->
