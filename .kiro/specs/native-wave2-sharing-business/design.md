# Design — Native Wave 2: Sharing / Business hub screen ports (native-wave2-sharing-business)

How the two lanes port the `sharing-business` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, `apps/mobile/README.md`, and the Commerce UX contract (`CLAUDE.md`, VTID-05204). Nothing here changes
the program plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `sharing` | `(app)/sharing/index.tsx`, `(app)/sharing/campaigns/index.tsx`, `(app)/sharing/campaigns/[id].tsx`, `(app)/sharing/distribution.tsx`, `(app)/sharing/data-consent.tsx`, `(app)/invite.tsx`, `(app)/creator/onboarded.tsx`, `(app)/pub/campaigns/[id].tsx` | `/sharing`, `/sharing/campaigns`, `/sharing/campaigns/:id`, `/sharing/distribution`, `/sharing/data-consent`, `/invite`, `/creator/onboarded`, `/pub/campaigns/:id` |
| `business-hub` | `(app)/business/index.tsx` (tabs `services`/`clients`/`sell-earn`/`analytics` + `?tab=…` via nested route / search param), `(app)/business/services.tsx`, `(app)/business/clients.tsx`, `(app)/business/sell-earn.tsx`, `(app)/business/analytics.tsx`, `(app)/business/opportunities.tsx`, `(app)/business/listings.tsx` | `/business` (+ `?tab=services.*|sales.*|insights.*`), `/business/services`, `/business/clients`, `/business/sell-earn`, `/business/analytics`, `/business/opportunities`, `/business/listings` |

Query-string variants (`?tab=services.events`, `?tab=sales.promotions`, `?tab=insights.earnings`, etc.) are the **same
route file** reading the search param (web: `pathToMobileTab` / `useSearchParams`, `BusinessHub.tsx:11,67`) — they are
distinct ledger rows but not distinct files, so they do not overlap across lanes. The ledger's shape-matching
(`shapeOf`, query dropped) is satisfied by the single `/business` file; the row **status** is still flipped per row.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (pure hooks/helpers, query keys, types, registry), `@vitana/ui`
  (UI kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`,
  `soundscape`, `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill` for the business-hub tab switcher, the kit's
  bottom sheets for campaign/template/package/automation dialogs, header chips from the shell.

### 2a. Sharing lane specifics (class-B re-implementation + share-image port)

The sharing pages (`Sharing.tsx`, `sharing/Campaigns.tsx`, `sharing/CampaignDetail.tsx`, `sharing/Distribution.tsx`,
`sharing/DataConsent.tsx`) compose the `src/components/sharing/**` library: blast center (`BlastCenter.tsx`, 429),
campaigns (`CampaignDialog`, `CampaignCard`, `ActivateCampaignDialog`, `DeleteCampaignDialog`), channels / connectors
(`ChannelConnector.tsx` 158, `InlineChannelConnector`, `ChannelEligibilityBadges`), templates (`TemplateDialog`),
packages (`CreatePackageDialog`, `EditPackageDialog`), the universal share dialog (`UniversalShareDialog.tsx`, 356),
automation rules (`AutomationRuleDialog.tsx`, 111) and scheduled / distribution posts (`NextScheduledPosts`,
`ScheduleDialog`, `CreatePostDialog`).

- **Class-B data access is re-implemented natively (design R1-B).** 10 of these components import
  `@/integrations/supabase/client` and `ChannelConnector` also uses `useChannels` — gateway/Supabase-coupled, so they
  do **not** extract to core. The native screens re-implement the fetch/mutation through the native Supabase client +
  native auth context (the home-feed plan's pattern for `useNewsFeed`/`useAllNewsFeed`), and consume only the pure
  helpers from core: campaign status/kind mapping, channel-eligibility logic, schedule formatting, audience selection
  — whatever is IO-free.
- **`html2canvas` → native capture (design R1-C).** `InstagramShareModal.tsx` generates the share card with
  `html2canvas` (`:2,52`). The native universal-share surface produces the same card image with
  `react-native-view-shot` (`captureRef`) or an equivalent native capture, feeding the OS share sheet. Flagged as a
  named port note; the image and flow match the web, only the capture mechanism differs.
- The two public landing routes (`/creator/onboarded` → `CreatorOnboarded.tsx`, `/pub/campaigns/:id` →
  `PublicCampaignLanding.tsx`) are leaf screens opened from a push / universal link; they are ported as plain screens
  on the shell.

### 2b. Business-hub lane specifics (one shell + the Commerce UX contract)

`/business` is a single shell screen (`BusinessHub.tsx`, 689) with nested `services`/`clients`/`sell-earn`/`analytics`
subroutes and `?tab=services.*|sales.*|insights.*` variants driven by `pathToMobileTab` and `useSearchParams`
(`:11,67`). The native port is one `(app)/business/index.tsx` plus the four nested files, switching tabs via the
`MobileModePill` the same way the web mobile layout drives `mobileTab`. It composes the business sub-tab components
`src/components/business/**` (`ServicesSubTabs`, `ClientsSubTabs`, `SellAndEarnSubTabs`, `AnalyticsSubTabs`) and the
organizer event-sales / reseller tabs `src/components/reseller/**` (`ResellerAvailableEventsTab`,
`ResellerCampaignsTab`) — business packages, operations panel, organizer event sales, reseller tabs and earnings.
`BusinessOpportunities.tsx` (138) and `BusinessListings.tsx` (153) are two standalone pages.

- **Commerce UX contract (R2.5).** The supplier-onboarding surfaces here (register a business, services/packages
  setup, sell-&-earn) are AI-led first, one dominant action per screen, plain business language, progressive
  disclosure. Because this lane is a **1:1 port of the existing mobile-web business screens**, it reproduces the web
  flow exactly — it adds no field, step, dialog or status the web screen lacks, so friction is **unchanged**. The
  lane's PR carries the contract's "UX acceptance" section stating exactly that (friction up/down vs web: "unchanged,
  1:1 port"; anything asked that could be inferred: "none — reproduces web").
- **Class-B data hooks re-implemented natively.** The pages fetch through hooks (earnings, growth, clients, services,
  reseller campaigns) that hit the gateway/Supabase; those are re-implemented natively. The pure logic
  (`pathToMobileTab`, IO-free earnings/growth aggregation and formatting helpers) extracts to core.

## 3. Disjointness (no overlap, no orphan)

- **Ledger rows (21):** the 21 `sharing-business` rows partition cleanly — **`sharing` 8** (`SHARING.OVERVIEW`,
  `SHARING.CAMPAIGNS`, `SHARING.CAMPAIGN_DETAIL`, `SHARING.DISTRIBUTION`, `SHARING.DATA_CONSENT`, `COMM.INVITE`,
  `/creator/onboarded`, `/pub/campaigns/:id`), **`business-hub` 13** (`BUSINESS.OVERVIEW`, `BUSINESS.SERVICES`,
  `BUSINESS.CLIENTS`, `BUSINESS.SELL_EARN`, `BUSINESS.ANALYTICS`, `BUSINESS.SERVICES_EVENTS`,
  `BUSINESS.SERVICES_PACKAGES`, `BUSINESS.SALES_PROMOTIONS`, `BUSINESS.SALES_REFERRALS`, `BUSINESS.INSIGHTS_EARNINGS`,
  `BUSINESS.INSIGHTS_GROWTH`, `BUSINESS.OPPORTUNITIES`, `BUSINESS.LISTINGS`). **8 + 13 = 21.** Each row named
  explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/` (one folder
  per lane: `app/(app)/sharing/**` + `app/(app)/invite.tsx` + `app/(app)/creator/**` + `app/(app)/pub/**` +
  `src/screens/sharing/`; `app/(app)/business/**` + `src/screens/business/`). No file is in two lanes.
- **Tests:** each lane owns its `apps/mobile/tests/<cluster>/**` folder (`tests/sharing/`, `tests/business/`) and its
  `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` + `packages/core/closure.generated.json` closure (each lane
  adds only the pure re-exports it needs), `apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`,
  `scripts/native/mobile-ci-paths.generated.json`, and the DE-first i18n shards (each lane adds only its screens'
  keys). These are listed in each lane's `paths`.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Two disjoint lanes by cluster: `sharing` and `business-hub`.** The brief's scope splits cleanly along the
   ledger's own key prefixes — the 8 non-`BUSINESS.` rows (all the `SHARING.*`, `COMM.INVITE`, and the two public
   routes) are the sharing/distribution surface; the 13 `BUSINESS.*` rows are the business hub. The two clusters touch
   disjoint route files and component folders (`src/components/sharing/**` vs `src/components/business/**` +
   `src/components/reseller/**`), build and review independently, and each leaves the app buildable. Reason recorded
   here per planning-mode rule.
2. **No cross-lane dependency (`depends_on: []` both).** There is no shared native twin or core module one lane owns
   and the other consumes — the sharing components and the business components are separate trees, and each lane adds
   only its own pure core re-exports. So the two lanes run fully in parallel, unlike the home-feed plan where `home`
   depended on `news` for the `NewsArticleCard` twin.
3. **Class-A-only core extraction; class-B re-implemented natively.** The gateway/Supabase-coupled channel
   connectors, campaign hooks and business data hooks are class-B (10 sharing components import the Supabase client;
   the business pages fetch through gateway hooks) and would fail `core-closure.mjs --check`, so they are
   re-implemented natively. Only pure, IO-free helpers (status/kind mapping, `pathToMobileTab`, formatting,
   aggregation) move into `@vitana/core` — each via a manifest line + a re-export in `packages/core/src/**` + `node
   scripts/native/core-closure.mjs --write` committed in the same lane PR, so `--check` passes. This is the same
   extraction model the home-feed plan applied to `feed-compose`/`news-feed-ranker`.
4. **html2canvas → React Native share-image.** The web share-card generation uses `html2canvas`, which has no React
   Native equivalent; the native share surface uses `react-native-view-shot` (`captureRef`) or an equivalent native
   capture. Flagged as a named port note (design R1-C), not a behaviour change.
5. **Commerce UX contract honoured by a 1:1 port.** The business-hub onboarding surfaces are AI-led, one dominant
   action per screen, plain language, progressive disclosure; porting reproduces the web flow exactly and adds no new
   field/step, so onboarding friction is unchanged. The lane PR carries the contract's "UX acceptance" section.
6. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json`; adding a native Expo Router file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status** flips
   (`not_started`→`in_progress`→`native`). The lane adds a native route file and a status flip, nothing in
   `src/navigation/registry/`.
7. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and the `staging-tests.json`. This matches the program's "fixture / fake-gateway tests only until G1" model
   (`.kiro/specs/health-native` handoff, `native-g1-wiring`).

## 5. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. Sharing: campaign list/detail load & empty & error; distribution / scheduled-posts render; channel
  connector connect/disconnect state (native re-implemented data mocked with fixtures); universal share dialog opens
  and the share-image capture is invoked (mocked `captureRef`); data-consent toggles; invite flow; the two public
  landings render from a fixture. Business-hub: the shell renders each tab (`services`/`clients`/`sell-earn`/
  `analytics` + the `?tab=` variants) from fixtures; opportunities and listings load/empty/error; reseller tabs and
  earnings render. Pure-module tests for any core helper a lane adds.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end; `pt` resolves (Brazilian você-form).
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Core closure:** `node scripts/native/core-closure.mjs --check` (after `--write` + commit of the generated files).
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present).
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `apps/mobile/maestro/<cluster>/*.yaml`, iOS simulator +
  Android emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen,
  listed in `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring

- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`.
- Whether the native share-image uses `react-native-view-shot` or another native capture library (decision 4 default:
  `react-native-view-shot`) — a one-line dependency choice, not a scope change.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
