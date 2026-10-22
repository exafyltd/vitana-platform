---
lane: sharing
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/sharing/**
  - apps/mobile/app/(app)/invite.tsx
  - apps/mobile/app/(app)/creator/**
  - apps/mobile/app/(app)/pub/**
  - apps/mobile/src/screens/sharing/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/sharing/**
  - apps/mobile/maestro/sharing/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - packages/core/extract.json
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/sharingNative.json
  - docs/validation/**
updated: 2026-10-21T19:13Z
---
# Sharing / distribution port — `/sharing` + campaigns + distribution + data-consent + `/invite` + the two public routes
Plan: `.kiro/specs/native-wave2-sharing-business/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: sharing -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on `exafyltd/vitana-v1` `origin/main`:** 8 ledger rows under `"lane": "sharing-business"` for this lane,
all `not_started` — `SHARING.OVERVIEW /sharing`, `SHARING.CAMPAIGNS /sharing/campaigns`,
`SHARING.CAMPAIGN_DETAIL /sharing/campaigns/:id`, `SHARING.DISTRIBUTION /sharing/distribution`,
`SHARING.DATA_CONSENT /sharing/data-consent`, `COMM.INVITE /invite`, and the two exclusion routes
`/creator/onboarded` and `/pub/campaigns/:id`. Web sources `src/pages/Sharing.tsx` (137), `src/pages/sharing/Campaigns.tsx`
(315, route `src/App.tsx:1584-1588`), `src/pages/sharing/CampaignDetail.tsx` (473, route `src/App.tsx:1589-1593`),
`src/pages/sharing/Distribution.tsx` (696, route `src/App.tsx:1594-1598`), `src/pages/sharing/DataConsent.tsx` (232,
route `src/App.tsx:1599-1603`), `src/pages/InviteFriends.tsx` (route `src/App.tsx:1551-1556`),
`src/pages/CreatorOnboarded.tsx` (route `src/App.tsx:1108-1112`), `src/pages/PublicCampaignLanding.tsx` (route
`src/App.tsx:860`); component library `src/components/sharing/**` (`BlastCenter.tsx` 429, `ChannelConnector.tsx` 158,
`UniversalShareDialog.tsx` 356, `AutomationRuleDialog.tsx` 111, `InstagramShareModal.tsx` with `html2canvas` at
`:2,52`). 10 of these components import `@/integrations/supabase/client` and `ChannelConnector` also imports
`useChannels` — **class B, re-implemented natively, not extracted.**
**Goal.** Port the sharing / distribution screens and the two public landing routes to native on the N3 shell at 1:1
mobile-web parity. Campaigns (list + detail), distribution (blast center, scheduled/distribution posts, templates,
packages), data-consent, the universal share dialog, channels / connectors, automation rules, invite, and the
`/creator/onboarded` + `/pub/campaigns/:id` leaf landings. Class-B channel/campaign data access re-implemented natively
(native Supabase client + native auth context); pure helpers consumed from `@vitana/core`. The web share-card
`html2canvas` generation is replaced by a native `react-native-view-shot` (`captureRef`) capture (design R1-C). Flips
all 8 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the sharing surfaces; mobile-web parity; `@vitana/core`-only web bridge (class-A only;
  class-B channel connectors / campaign hooks re-implemented natively); the html2canvas→native share-image port.
- `npm run typecheck`, `npm test` (campaign list/detail load/empty/error; distribution & scheduled-posts render;
  channel connect/disconnect state; universal share dialog opens + `captureRef` invoked; data-consent toggles; invite
  flow; both public landings render), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 8
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored, `pt` Brazilian você-form;
  RTL (`ar`) covered (start/end only); no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's read-only spec)
  and `plan-sparring.md` (copy of the plan's sparring record).
- **Device-runtime parity (task 8)** — Maestro + sim/emulator screenshots + parity vs 390×844 staging — is deferred
  to G1 as `next_actor: owner`; not a merge blocker for the port, recorded in this log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 8 rows), `packages/core/manifest.json`
+ `closure.generated.json` + `src/**` (only the pure class-A re-exports this lane adds),
`scripts/native/mobile-ci-paths.generated.json`, `apps/mobile/src/ports/**`,
`apps/mobile/src/navigation/resolve.ts`, and the DE-first i18n shard are shared by row/line with `business-hub`;
resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T19:13Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 8 rows and the paths were computed from the parity
ledger on `origin/main` and `src/App.tsx` so no file belongs to two lanes. No deps — runs in parallel with
`business-hub`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-sharing-business/sharing --session <id>`).
