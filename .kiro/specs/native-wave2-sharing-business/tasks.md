# Tasks — Native Wave 2: Sharing / Business hub screen ports

Two lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.

<!-- lane: sharing -->
## Lane `sharing` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (8 ledger rows under `"lane": "sharing-business"`): `SHARING.OVERVIEW /sharing`,
`SHARING.CAMPAIGNS /sharing/campaigns`, `SHARING.CAMPAIGN_DETAIL /sharing/campaigns/:id`,
`SHARING.DISTRIBUTION /sharing/distribution`, `SHARING.DATA_CONSENT /sharing/data-consent`, `COMM.INVITE /invite`,
`/creator/onboarded`, `/pub/campaigns/:id`. depends_on: none. Web sources `src/pages/Sharing.tsx` (137),
`src/pages/sharing/Campaigns.tsx` (315), `src/pages/sharing/CampaignDetail.tsx` (473),
`src/pages/sharing/Distribution.tsx` (696), `src/pages/sharing/DataConsent.tsx` (232), `src/pages/InviteFriends.tsx`,
`src/pages/CreatorOnboarded.tsx`, `src/pages/PublicCampaignLanding.tsx`; component library `src/components/sharing/**`.

- [ ] 1. Core re-exports (class-A only): add the pure, IO-free helpers the sharing screens use (campaign status/kind
  mapping, channel-eligibility logic, schedule/audience formatting — whichever reach no `@/integrations/supabase/client`
  / gateway import) to `@vitana/core` via a `packages/core/manifest.json` line + a re-export in `packages/core/src/**`,
  then `node scripts/native/core-closure.mjs --write`. The class-B channel connectors / campaign hooks
  (`ChannelConnector`, `useChannels`, the 10 Supabase-coupled components) are NOT extracted — their data access is
  re-implemented natively in task 2/3.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Sharing overview + campaigns: `apps/mobile/app/(app)/sharing/index.tsx` (twin of `Sharing.tsx`),
  `apps/mobile/app/(app)/sharing/campaigns/index.tsx` (list, twin of `sharing/Campaigns.tsx`),
  `apps/mobile/app/(app)/sharing/campaigns/[id].tsx` (detail, twin of `sharing/CampaignDetail.tsx`) +
  `apps/mobile/src/screens/sharing/**`. Channel connector / campaign data re-implemented natively (native Supabase
  client + native auth context); campaign cards/dialogs as kit bottom sheets. Mobile-web branch only.
  Files: `apps/mobile/app/(app)/sharing/**`, `apps/mobile/src/screens/sharing/**`.
  Verify: `npm test` (campaign list/detail load/empty/error) + `npm run typecheck` green.
- [ ] 3. Distribution + data-consent + universal share (incl. the html2canvas → native share-image port):
  `apps/mobile/app/(app)/sharing/distribution.tsx` (twin of `Distribution.tsx`: blast center, scheduled/distribution
  posts, templates, packages), `apps/mobile/app/(app)/sharing/data-consent.tsx` (twin of `DataConsent.tsx`), and the
  universal share dialog / Instagram-share surface — the share card image is produced with `react-native-view-shot`
  (`captureRef`) or an equivalent native capture (design R1-C), NOT `html2canvas`, feeding the OS share sheet.
  Files: `apps/mobile/app/(app)/sharing/**`, `apps/mobile/src/screens/sharing/**`.
  Verify: `npm test` (distribution/scheduled render; share dialog opens; `captureRef` invoked, mocked) +
  `npm run typecheck` green.
- [ ] 4. Invite + the two public landings: `apps/mobile/app/(app)/invite.tsx` (twin of `InviteFriends.tsx`),
  `apps/mobile/app/(app)/creator/onboarded.tsx` (twin of `CreatorOnboarded.tsx`),
  `apps/mobile/app/(app)/pub/campaigns/[id].tsx` (twin of `PublicCampaignLanding.tsx`) + `src/screens/sharing/**`.
  Leaf screens opened from a push / universal link.
  Files: `apps/mobile/app/(app)/invite.tsx`, `apps/mobile/app/(app)/creator/**`, `apps/mobile/app/(app)/pub/**`,
  `apps/mobile/src/screens/sharing/**`.
  Verify: `npm test` (each resolves from a fixture + deep link) + `npm run typecheck` green.
- [ ] 5. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to
  `src/i18n/de/sharingNative.json` first (du-form), then the other ten (ar en es fr pl pt ru sr tr zh); `pt` Brazilian
  você-form; render under `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/sharingNative.json` (DE first), `apps/mobile/src/screens/sharing/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures, no network): campaign list/detail load/empty/error; distribution &
  scheduled-posts render; channel connect/disconnect state; universal share dialog opens and `captureRef` invoked;
  data-consent toggles; invite flow; both public landings render. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/sharing/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 8 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (sharing rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/sharing/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging sharing screens. Blocked until G1 (and macOS minutes / G3 for iOS on a
  device).
  Files: `apps/mobile/maestro/sharing/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 9. PR: branch `kiro/native-wave2-sharing-business/sharing`, title
  `VTID-xxxxx (native-wave2-sharing-business/sharing): native sharing / distribution port`, body names the Kiro
  session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-sharing-business/sharing`. Lane → `in-review`, `next_actor: kiro` (reviewer seat
  `hotmail`). Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: business-hub -->
## Lane `business-hub` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (13 ledger rows): `BUSINESS.OVERVIEW /business`, `BUSINESS.SERVICES /business/services`,
`BUSINESS.CLIENTS /business/clients`, `BUSINESS.SELL_EARN /business/sell-earn`, `BUSINESS.ANALYTICS /business/analytics`,
`BUSINESS.SERVICES_EVENTS /business?tab=services.events`, `BUSINESS.SERVICES_PACKAGES /business?tab=services.packages`,
`BUSINESS.SALES_PROMOTIONS /business?tab=sales.promotions`, `BUSINESS.SALES_REFERRALS /business?tab=sales.referrals`,
`BUSINESS.INSIGHTS_EARNINGS /business?tab=insights.earnings`, `BUSINESS.INSIGHTS_GROWTH /business?tab=insights.growth`,
`BUSINESS.OPPORTUNITIES /business/opportunities`, `BUSINESS.LISTINGS /business/listings`. depends_on: none. Web sources
`src/pages/BusinessHub.tsx` (689, route `src/App.tsx:1295-1306`), `src/pages/BusinessOpportunities.tsx` (138, route
`src/App.tsx:1527-1531`), `src/pages/BusinessListings.tsx` (153, route `src/App.tsx:1532-1536`); sub-tab components
`src/components/business/**`, organizer / reseller tabs `src/components/reseller/**`.

- [ ] 1. Core re-exports (class-A only): add the pure, IO-free helpers (the tab mapping `pathToMobileTab`, IO-free
  earnings/growth aggregation and formatting) to `@vitana/core` via the manifest + a re-export in `packages/core/src/**`,
  then `node scripts/native/core-closure.mjs --write`. The business data hooks (earnings, growth, clients, services,
  reseller campaigns — gateway/Supabase-coupled) are NOT extracted — re-implemented natively in tasks 2–3.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Business hub shell + tabs: `apps/mobile/app/(app)/business/index.tsx` (twin of `BusinessHub.tsx`, the
  `MobileModePill` tab switcher driving `services`/`clients`/`sell-earn`/`analytics` and the `?tab=services.*|sales.*|
  insights.*` variants via the search param, mirroring `pathToMobileTab`) + the nested files
  `apps/mobile/app/(app)/business/{services,clients,sell-earn,analytics}.tsx` + `src/screens/business/**`. Composes the
  `ServicesSubTabs` / `ClientsSubTabs` / `SellAndEarnSubTabs` / `AnalyticsSubTabs` twins and the reseller / organizer
  event-sales tabs (`ResellerAvailableEventsTab`, `ResellerCampaignsTab`), data re-implemented natively. Mobile-web
  branch only. **Commerce UX contract (R2.5): 1:1 port, AI-led, one dominant action per screen, no added field/step.**
  Files: `apps/mobile/app/(app)/business/**`, `apps/mobile/src/screens/business/**`.
  Verify: `npm test` (each tab renders from fixtures) + `npm run typecheck` green.
- [ ] 3. Opportunities + listings: `apps/mobile/app/(app)/business/opportunities.tsx` (twin of
  `BusinessOpportunities.tsx`), `apps/mobile/app/(app)/business/listings.tsx` (twin of `BusinessListings.tsx`) +
  `src/screens/business/**`. Data re-implemented natively.
  Files: `apps/mobile/app/(app)/business/**`, `apps/mobile/src/screens/business/**`.
  Verify: `npm test` (load/empty/error) + `npm run typecheck` green.
- [ ] 4. i18n + RTL (as sharing task 5) across all business-hub screens; new keys DE-first
  (`src/i18n/de/businessNative.json`) then the other ten; `pt` Brazilian você-form; `ar` start/end only.
  Files: `src/i18n/*/businessNative.json` (DE first), `apps/mobile/src/screens/business/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures) per screen: shell renders each tab + `?tab=` variant from fixtures;
  opportunities and listings load/empty/error; reseller tabs and earnings render. React 19 `ReactElement`.
  Files: `apps/mobile/tests/business/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the 13 parity rows to `native`; `--sync` then `--check`. The `?tab=…` rows match the single `/business`
  route file by `shapeOf()` — their status must still each be flipped to `native`.
  Files: `apps/mobile/parity/ledger.json` (business-hub rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/business/*.yaml` +
  sim/emulator screenshots + parity vs the 390×844 read-only staging business screens. Blocked until G1 (+ macOS/G3
  for iOS).
  Files: `apps/mobile/maestro/business/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-sharing-business/business-hub`, title
  `VTID-xxxxx (native-wave2-sharing-business/business-hub): native business hub port`; body names the Kiro session id,
  Summary / Decisions taken / Tests / **UX acceptance** (Commerce UX contract) / Handoff; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-sharing-business/business-hub`; lane → `in-review`, `next_actor: kiro`. No
  merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge
  (class-A only; class-B re-implemented natively).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys (`pt` Brazilian você-form), RTL covered; no hardcoded user-visible text; no physical
  `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`. The
  business-hub PR additionally carries the Commerce UX "UX acceptance" section (friction unchanged, 1:1 port).
- Device-runtime parity (the G1 task) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for the
  port, it is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
