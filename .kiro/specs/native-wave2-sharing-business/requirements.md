# Requirements — Native Wave 2: Sharing / Business hub screen ports (native-wave2-sharing-business)

Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the sharing / distribution screens and the
business-hub screens that the parity ledger assigns to the `sharing-business` lane to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens`
+ the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device
needs the isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured on `exafyltd/vitana-v1` `origin/main`, parity ledger `apps/mobile/parity/ledger.json` version 2:
**21 rows carry `"lane": "sharing-business"`, every one `status: "not_started"`** (19 `screen`, 2 `route`;
435 rows total). Counted with `node -e` over the ledger JSON read from `origin/main`
(`git show origin/main:apps/mobile/parity/ledger.json | node …`; the `--report` command needs `typescript`, which is
not installed in this worktree). The two lanes below partition those 21 rows with **disjoint `paths`**.

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), the Spotlight / design
rules via tokens, and the **Commerce UX contract** (`CLAUDE.md` "Commerce UX contract — supplier onboarding",
VTID-05204) for every supplier/business onboarding surface in the business-hub lane. No new web screen, no `App.tsx`
route, no `screens.json` / `exclusions.json` entry is added by this plan (ports only), so no `screen-manifest` or
voice-registry change and no new native parity row — only status flips on existing rows.

## R0 — Scope and the two lanes

0.1 The plan ports exactly the 21 web destinations the parity ledger lists under `"lane": "sharing-business"`, split
into two disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane. Partition:
**`sharing` 8 rows + `business-hub` 13 rows = 21** (0 overlap, 0 orphan).

0.2 Lane **`sharing`** — the sharing / distribution / campaign surfaces and the two public landing routes
(8 ledger rows):
`SHARING.OVERVIEW /sharing` (web `src/pages/Sharing.tsx`, 137 lines; route `src/App.tsx:1579-1583`),
`SHARING.CAMPAIGNS /sharing/campaigns` (web `src/pages/sharing/Campaigns.tsx`, 315 lines; route
`src/App.tsx:1584-1588`), `SHARING.CAMPAIGN_DETAIL /sharing/campaigns/:id` (web
`src/pages/sharing/CampaignDetail.tsx`, 473 lines; route `src/App.tsx:1589-1593`),
`SHARING.DISTRIBUTION /sharing/distribution` (web `src/pages/sharing/Distribution.tsx`, 696 lines; route
`src/App.tsx:1594-1598`), `SHARING.DATA_CONSENT /sharing/data-consent` (web `src/pages/sharing/DataConsent.tsx`,
232 lines; route `src/App.tsx:1599-1603`), `COMM.INVITE /invite` (web `src/pages/InviteFriends.tsx`; route
`src/App.tsx:1551-1556`), and the two **exclusion route rows** `/creator/onboarded` (web
`src/pages/CreatorOnboarded.tsx`; route `src/App.tsx:1108-1112`) and `/pub/campaigns/:id` (web
`src/pages/PublicCampaignLanding.tsx`; route `src/App.tsx:860`) — each a dedicated ledger row
(`source: exclusion`, `scope: in`, `lane: sharing-business`, from `src/navigation/registry/exclusions.json` /
`scripts/native/parity-scope.json`). The sharing component library under `src/components/sharing/**` (blast center,
campaigns, channels/connectors, templates, packages, universal share dialog, automation rules, scheduled /
distribution posts) is the implementation surface these pages compose.

0.3 Lane **`business-hub`** — the business hub, its tabs and the two standalone business pages (13 ledger rows):
`BUSINESS.OVERVIEW /business`, `BUSINESS.SERVICES /business/services`, `BUSINESS.CLIENTS /business/clients`,
`BUSINESS.SELL_EARN /business/sell-earn`, `BUSINESS.ANALYTICS /business/analytics`,
`BUSINESS.SERVICES_EVENTS /business?tab=services.events`, `BUSINESS.SERVICES_PACKAGES /business?tab=services.packages`,
`BUSINESS.SALES_PROMOTIONS /business?tab=sales.promotions`, `BUSINESS.SALES_REFERRALS /business?tab=sales.referrals`,
`BUSINESS.INSIGHTS_EARNINGS /business?tab=insights.earnings`, `BUSINESS.INSIGHTS_GROWTH /business?tab=insights.growth`
(all one shell, web `src/pages/BusinessHub.tsx`, 689 lines; route `src/App.tsx:1295-1306` — a `/business` shell with
nested index/`services`/`clients`/`sell-earn`/`analytics` subroutes, the `?tab=…` variants read from
`useSearchParams()`/path via `pathToMobileTab`), plus `BUSINESS.OPPORTUNITIES /business/opportunities` (web
`src/pages/BusinessOpportunities.tsx`, 138 lines; route `src/App.tsx:1527-1531`) and
`BUSINESS.LISTINGS /business/listings` (web `src/pages/BusinessListings.tsx`, 153 lines; route
`src/App.tsx:1532-1536`). Composes the business sub-tab components `src/components/business/**` (ServicesSubTabs,
ClientsSubTabs, SellAndEarnSubTabs, AnalyticsSubTabs) and the reseller tabs `src/components/reseller/**`
(ResellerAvailableEventsTab, ResellerCampaignsTab) and organizer event-sales / earnings surfaces.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button
RTL side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.

1.4 Business logic, query keys, types and pure composition are reused from `@vitana/core`, never re-implemented. A web
module a lane needs that is not yet re-exported is added to `packages/core/manifest.json` with a re-export in the same
lane PR and `node scripts/native/core-closure.mjs --write` run (program §3; `apps/mobile/README.md` "Web code:
`@vitana/core`"). `@vitana/core` is the only web→native bridge; ESLint bans `@/` and relative paths into the web
`src/` from app code.

### R1-B — class-A core extraction only; class-B is re-implemented natively

1.5 **Only pure, IO-free modules move into `@vitana/core`.** A module is class **A** when `core-closure.mjs`'s BFS
reaches no class-**B** file: no `@/integrations/supabase/client` import, no `community-gateway` / `gatewayFetch` /
`@/lib/gateway` import, no `import.meta.env` / `localStorage` / `window` / DOM coupling (`core-closure.mjs:150`,
`m.own !== 'A'`). **Type-only imports are excluded from the runtime graph** (`extraction-deps.mjs:183`) and the native
tsconfig `@/*` → `../../src/*` alias (`apps/mobile/tsconfig.json`) resolves them at compile time, so a type-only edge
does not pull a module into the closure.

1.6 **The channel connectors and campaign hooks are class-B and are re-implemented natively, NOT extracted.** Measured
on `origin/main`: 10 of the `src/components/sharing/**` components import `@/integrations/supabase/client`
(`ChannelConnector.tsx:19`, `InlineChannelConnector`, `BlastCenter`, `CampaignDialog`, `CreatePackageDialog`,
`EditPackageDialog`, `CreatePostDialog`, `TemplateDialog`, `AutomationRuleDialog`, `UniversalShareDialog`), and
`ChannelConnector` also pulls `useChannels` (`ChannelConnector.tsx:18`). These hit the gateway / Supabase, so they
would fail the closure gate — the sharing lane **re-implements their data access natively** (native Supabase client +
native auth context, the same pattern the home-feed plan used for `useNewsFeed`/`useAllNewsFeed`) and consumes only
the pure helpers (formatting, status/kind mapping, selection logic) from core. The business-hub pages
(`BusinessHub.tsx` and the sub-tab / reseller components) likewise fetch through hooks; their pure logic (tab mapping
`pathToMobileTab`, earnings/growth aggregation helpers that are IO-free) extracts to core, their data hooks are
re-implemented natively.

### R1-C — html2canvas → React Native share-image (parity port note)

1.7 **`html2canvas` does not exist in React Native.** Web generates the shareable card image with
`html2canvas` (`src/components/sharing/InstagramShareModal.tsx:2,52`). The native universal-share / share-image
surface renders the card with a native approach — `react-native-view-shot` (`captureRef`) or an equivalent native
capture — to produce the same image for the share sheet. This is a **named parity/port note** for the sharing lane's
universal share dialog / Instagram-share / share-image surface, not a behaviour change: the resulting image and the
share flow match the web screen; only the capture mechanism differs.

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`, du-form) then mirrored to the other ten. **`pt` is Brazilian você-form; `ar` is RTL**
(`start`/`end`, never `left`/`right`).

2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it (`pt` Brazilian você-form); a lane that can reuse an existing key does so and adds none.

## R2-C — Commerce UX contract (business-hub onboarding surfaces)

2.5 Every supplier/business onboarding surface in the `business-hub` lane follows the Commerce UX contract
(`CLAUDE.md` "Commerce UX contract — supplier onboarding", VTID-05204): **AI-led, not form-led** (the primary path is
the supplier's assistant setting the business up; manual onboarding is the fallback and must not make the AI path more
complex); **one dominant action per screen**; **plain business language** (no IDs, connector names, step keys or
lifecycle states in normal supplier UX); progressive disclosure; never ask twice for the same information; a human is
required only for legal acceptance, identity/verification, payment/bank details and final sensitive confirmations.
Because these are **1:1 ports of the existing mobile-web business screens**, the native port reproduces the web
screen's flow unchanged — it adds no field, step, dialog or status the web screen does not already have, so it cannot
increase onboarding friction. The business-hub lane's PR carries the contract's **"UX acceptance" section** (user
steps · required fields · decisions · anything asked that could be inferred — must be "none" or justified · can the
user always tell what to do next · friction up/down vs. web — must be "unchanged, 1:1 port").

## R3 — React 19 / native typing

3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger

4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`, and
no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The `?tab=…` rows match by exact
`shapeOf()` (query dropped) against the single `/business` route file, so the shell route satisfies every
`BUSINESS.*?tab=` row — but each row's **status** must still be flipped to `native` or the ledger reports the lane
permanently incomplete (the home-feed plan's `/home/*` finding applies here to the `?tab=` rows).

4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The two lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.

5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.

5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered; `pt` Brazilian você-form.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
`core-closure --check` green; NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane
scope PR-GATE checks green.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record). The business-hub lane's PR carries the Commerce UX
acceptance section.

## Out of scope (named so a lane does not drift into them)

- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, `wallet`, etc.) — each is its own plan.
- Commerce checkout / wallet / ticketing reached from a business or campaign screen (those rows are
  `discover-commerce` / `wallet` lanes); this plan links to them by route only.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first, `pt` Brazilian você-form) and a `@vitana/core` re-export
  line.
