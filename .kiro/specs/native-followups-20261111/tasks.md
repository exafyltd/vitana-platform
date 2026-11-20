# Tasks — native-followups-20261111

One PR per lane, all in `exafyltd/vitana-v1`. Branch `kiro/native-followups-20261111/<lane-id>`, title
`VTID-xxxxx (native-followups-20261111/<lane-id>): …`, trailers `Collab-Session` and `Collab-Lane`. A lane changes only its `paths`.
VTIDs are assigned by CI after PLAN-SPAR converges; do not start a lane before its `vtid:` is set. Every app lane runs
`cd apps/mobile && npm ci && npm test && npm run typecheck`. New tests are written first and recorded red on `origin/main` in
`docs/validation/<VTID>/red-on-base.txt` and `commands.log`. No store build, no signing, no credential, no production host.
The owner-approved edits to existing tests are listed in each lane and in its PR body; **no other existing test is edited**.
Held back (not lanes): the German "Sie" string and the push body, see `plan.md`.

<!-- lane: partner-orgs-path -->
## Lane `partner-orgs-path` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: []. Owner-approved existing-test edits: `tests/shell.test.tsx:49` and `tests/identity.test.tsx:149`, the fake-gateway key only.

- [ ] 0. Ownership check (sparring R1-F1), at claim time and again before opening the PR: `gh api repos/exafyltd/vitana-v1/pulls/1645/files --jq '.[].filename'` and `git log origin/main -- apps/mobile/src/identity/useMyPartnerOrgs.ts apps/mobile/tests/identity.test.tsx apps/mobile/tests/shell.test.tsx`.
  The lane `native-shell-fixes-r2/shell-fixes` (VTID-05647) declares the hook and `identity.test.tsx` in its paths but its PR does not edit them. If any of the three files is already changed by #1645 or on main, stop, merge `origin/main` and do only what is left; record the finding in the lane log. Say in the PR body that this lane took over those edits from `shell-fixes`.
- [ ] 1. Red test `tests/followups/partner-orgs/partner-orgs-url.test.tsx`: install a real `createGatewayFetch` with a recording `fetchImpl` (pattern of
  `tests/shell-fixes/gateway-paths.test.tsx` in #1645, copied, not imported), render `useMyPartnerOrgs` signed in, and assert the requested URL list equals
  `['https://gw.test/api/v1/partner-orgs/mine']` and the hook returns the organizations. Red on base: the URL is `https://gw.test/api/v1/api/v1/partner-orgs/mine`.
- [ ] 2. `apps/mobile/src/identity/useMyPartnerOrgs.ts:23`: `gatewayGet('/partner-orgs/mine')`; update the header comment (`:3`) to say the prefix is added by the gateway client.
- [ ] 3. `tests/shell.test.tsx:49` and `tests/identity.test.tsx:149`: change the key `'/api/v1/partner-orgs/mine'` to `'/partner-orgs/mine'`. Nothing else in either file. Show the two-line diff in the PR body.
- [ ] 4. Must-pass list, recorded one by one in `commands.log` and the PR body (sparring R1-F2): `tests/shell.test.tsx`, `tests/identity.test.tsx`, `tests/professional/bottom-tabs.test.tsx`, `tests/staff/chrome.test.tsx`, `tests/shell-fixes` (if #1645 has merged) and the full suite.
  The last two professional/staff files still key the doubled path with `organizations: []`; they are **not edited** and must stay green (`data` is `undefined` → `EMPTY`, `useBusinessMode.ts:15-17`). Record them in the PR as stale fixtures.
- [ ] 5. If #1645 has merged, re-read `GuidedModeProvider.tsx` and `AuthGate.tsx` on the new `origin/main`; this lane does not touch them. Verify and PR.

**Acceptance (the reviewer agent checks these):**
- Change types: Integration, Tooling/docs.
- **Outcome** — the side drawer and business mode read the member's partner organizations from `GET <gateway>/api/v1/partner-orgs/mine` instead of a doubled, 404-ing URL; a member with an organization sees it.
- **States** — signed out (query disabled), 404/error (empty list as today), empty list, list with one organization.
- **Surfaces** — `SideDrawer.tsx:78` and `useBusinessMode.ts:16`; no screen changes.
- **Locales** — n/a: no text. **Accessibility** — n/a: no UI.
- **Contract** — request `GET /api/v1/partner-orgs/mine` with bearer; response `{ organizations?: MyOrgRow[] }` (client `useMyPartnerOrgs.ts:23-24`; gateway route `/api/v1/partner-orgs/*`, VTID-03932/03935, web `src/hooks/useOrgMembers.ts:85`). The URL is built by `createGatewayFetch` (`packages/core/src/gateway.ts:22`).
- **Staging proof** — not verified on staging (no native staging deploy); covered by the new URL test and the two key-edited tests.
- `tests/professional/bottom-tabs.test.tsx` and `tests/staff/chrome.test.tsx` (stale doubled key, not edited) are run and green after the fix, named in the PR body.
- The diff of `tests/shell.test.tsx` and `tests/identity.test.tsx` is exactly one changed line each (the key). New test red on base; no file outside `paths`; NATIVE-CI, **Collab handoff**, **Lane scope** green.

<!-- lane: my-groups-deeplink -->
## Lane `my-groups-deeplink` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: []. Owner-approved existing-test edit: the one pin change in `tests/discover-commerce/routes.test.tsx:117-120`.

- [ ] 1. Red test `tests/followups/my-groups/my-groups-deeplink.test.tsx`: `resolveWebPath('/comm/my-groups/g-1')` → `{ kind: 'native', href: '/comm/my-groups/g-1', path: '/comm/my-groups/g-1' }`; with `?x=1` the query is kept;
  `/comm/my-groups` and `/comm/my-groups/g-1/extra` are not native; a cold-start render (`renderRouter` with `'(app)/[...path]'` = the resolver and `'(app)/comm/my-groups/[id]'`) of `/comm/my-groups/g-1` reaches the route, not an `unported` screen.
  Red on base: `kind` is `unported`.
- [ ] 1b. Overlap note (sparring R2-F1): lane `native-shell-fixes-r2/shell-fixes` (VTID-05647) also declares `resolve.ts` in its paths (`lanes/shell-fixes.md:16`) and plans four `NATIVE_ROUTES` entries (`native-shell-fixes-r2/plan.md:64-69`); #1645 does not edit `resolve.ts` today. This lane edits `NATIVE_PATTERNS`, a different array, so any conflict is additive (keep both sides). Re-check #1645's file list before the PR. #1645 joins the collision list of #1587 #1604 #1608 #1619 #1620 #1623 #1634 #1636 #1646 #1647 for `resolve.ts`; `screen-backfill` applies the same note to its `NATIVE_ROUTES` entry.
- [ ] 2. `apps/mobile/src/navigation/resolve.ts:154`: `NATIVE_PATTERNS = ['/discover/provider/:id', '/comm/my-groups/:id']`; extend the comment at `:150-153` to name VTID of this lane and the route. Do not touch `NATIVE_ROUTES`.
- [ ] 3. `tests/discover-commerce/routes.test.tsx:117-120`: change only the `toEqual` list (and the test title, which says "this lane's provider route only") to the two patterns. Keep the second assertion (`/discover/provider` is not native). List this change in the PR body.
- [ ] 4. Run `tests/navigation.test.tsx`, `tests/discover-commerce`, `tests/parity-gaps` (if #1657 has merged), `tests/community`, and the full suite. Verify and PR.

**Acceptance (the reviewer agent checks these):**
- Change types: UI (navigation), Tooling/docs.
- **Outcome** — a link or an ORB navigation to `/comm/my-groups/<id>` opens the group detail in the app instead of the "not available on the app" screen.
- **States** — with id, with query, without id (not native), extra segment (not native), cold start.
- **Surfaces** — the resolver (`app/(app)/[...path].tsx`), ORB/deep-link navigation; the route file is unchanged.
- **Locales** — n/a: no text. **Accessibility** — n/a: no UI.
- **Contract** — `resolveWebPath` in `src/navigation/resolve.ts`; `NATIVE_PATTERNS` consumed at `:200`; route file `app/(app)/comm/my-groups/[id].tsx`; pin at `tests/discover-commerce/routes.test.tsx:118`.
- **Staging proof** — not verified on staging (no native staging deploy); covered by the new test and `tests/navigation.test.tsx`.
- Only one line list of `routes.test.tsx` changes (plus its title); new test red on base; no file outside `paths`; NATIVE-CI, **Collab handoff**, **Lane scope** green.

<!-- lane: i18n-rtl-deterministic -->
## Lane `i18n-rtl-deterministic` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: []. The only file changed is the test itself (plus `docs/validation/**`); it is the lane's whole subject.

- [ ] 1. Reproduce on base and record it in `docs/validation/<VTID>/red-on-base.txt`: run `npx jest tests/settings/i18n-rtl.test.tsx` repeatedly under CPU load (for example three parallel `npx jest` runs of heavy suites, or
  `--maxWorkers=1` next to a busy loop) until `Arabic renders right-to-left…` fails with `Unable to find node on an unmounted component` (CI evidence: `sh-ci2.log:27139`, error at test `:103:65`).
  If it cannot be reproduced, say so and still apply task 2, which is correct by construction.
- [ ] 2. Arabic test (`:96-105`): replace the held element with a re-querying wait:
  `await waitFor(() => expect(screen.getByTestId('tenant-role-current-role')).toHaveTextContent(/عضو في المجتمع/))`, then `expect(rtl).toBe(true)`. Same matcher, same regex, same expectations.
- [ ] 3. 11-locale loops (`:60-80`): no element is kept across an await; after `findByTestId`, every later read is a fresh `getByTestId`/`queryBy…` inside the `waitFor` that needs it; the `billing-loading` wait stays;
  unmount between locales (`screen.unmount()` or the RNTL cleanup) so a late query update from locale N cannot land in locale N+1's tree. Optional and additive only: an explicit `configure({ asyncUtilTimeout })` for this file (pattern `tests/discover-commerce/timing.ts`), never as the only change.
- [ ] 4. Leave the catalog test (`:82-94`) and the physical left/right test (`:107-123`) untouched. Count `it(`/`it.each` rows and `expect(` calls before and after; the counts must be equal or higher.
- [ ] 5. Flake proof in `verification.md`: 5 consecutive passes alone, 3 consecutive passes under artificial CPU load, and one full `npm test`.

**Acceptance (the reviewer agent checks these):**
- Change types: Tooling/docs (test only).
- **Outcome** — CI no longer fails on `tests/settings/i18n-rtl.test.tsx` when the runner is slow; a failure now means a real RTL or catalog defect.
- **States** — slow runner, late query resolution, late language provider update.
- **Surfaces** — n/a: no app code changes. **Locales** — all 11 locales still rendered and checked (`LOCALES`). **Accessibility** — n/a.
- **Contract** — n/a: no boundary crossed.
- **Staging proof** — not verified on staging: a test-only change; proof is the repeated runs under load in `verification.md`.
- **No assertion is removed, weakened or skipped** (`it.skip`, `xit`, `test.todo`, a looser matcher or a smaller locale/mode list are all findings); the number of tests and `expect` calls is not lower than on base; **no timeout is raised as the only fix**; no file other than `tests/settings/i18n-rtl.test.tsx` and `docs/validation/**`. NATIVE-CI, **Collab handoff**, **Lane scope** green.

<!-- lane: translations -->
## Lane `translations` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: []. Turkish only. The German "Sie" string is held back (two existing tests assert it; `plan.md` "Held back"); this lane does not touch `src/i18n/de/**`, `PartnerTermsSheet.vtid-04909.test.tsx` or `commerce-terms.vtid-04895.test.ts`.

- [ ] 1. Red test `src/i18n/tr-screens-no-empty-values.test.ts` (vitest, pattern of `src/i18n/locale-registration.test.ts`): load `src/i18n/tr/screens.json`, walk every string value, assert none is empty after trim; assert
  `screens.profile.dancePreferences` and `screens.sharing.stressLevels` are non-empty, still contain the 💃 emoji for the first, and that both keys exist in `de` and `en` with non-empty values. Red on base: the two keys are `""`.
- [ ] 2. `src/i18n/tr/screens.json:6777` → `"💃 Dans tercihleri"`; `:8145` → `"Stres seviyeleri"`. Nothing else in the file. Check the line numbers on the new `origin/main` first (the file is large and #1605 edits it elsewhere).
- [ ] 3. Run `npx vitest run src/i18n src/lib/commerce-terms.vtid-04895.test.ts src/components/commerce/PartnerTermsSheet.vtid-04909.test.tsx` (the last two are unchanged and must stay green). No key is added or removed, so `npm run i18n:inventory` needs no new run.
- [ ] 4. Before the PR, `git grep -n "Dans tercihleri\|Stres seviyeleri\|dancePreferences\|stressLevels"` over `src`, `apps/mobile/tests` and `tests`; record that no test asserts the old (empty) values.

**Acceptance (the reviewer agent checks these):**
- Change types: UI (copy), Tooling/docs.
- **Outcome** — a Turkish-language member sees "💃 Dans tercihleri" on the dance section of a profile and "Stres seviyeleri" where stress levels are shown, instead of a blank label.
- **States** — empty value (the defect), long text n/a (short noun phrases).
- **Surfaces** — `src/components/profile/sections/DancePublicSection.tsx:61`; the sharing screens that use `screens.sharing.stressLevels`.
- **Locales** — `tr` only; `de` and `en` are the source and are read, not changed. Noun phrases carry no formal/informal address (du-equivalent informal register holds by construction). No `_pending_review` flag is removed or added.
- **Accessibility** — a visible label replaces an empty one.
- **Contract** — catalog key paths `screens.profile.dancePreferences`, `screens.sharing.stressLevels` unchanged; only the two values change.
- **Staging proof** — not verified on staging: the web build has no read-only Turkish spec for these two labels; covered by the new test and the two unchanged terms tests.
- Exactly two lines change in `src/i18n/tr/screens.json`; new test red on base; no file outside `paths`; the German file and the two pinning tests are untouched. PR checks and **Lane scope** green.

<!-- lane: screen-backfill -->
## Lane `screen-backfill` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
**Supersedes** lane `native-wave2-fix-forward-r2/screen-backfill` (VTID-05651); nothing is built under the old lane. depends_on: `my-groups-deeplink` (both edit `src/navigation/resolve.ts`, a hot file, so they are sequenced).
**Start condition (task 0): vitana-v1 PR #1639 (`native-wave2-fix-forward-r2/orb-guided-topic`, VTID-05649) is merged** (`gh api repos/exafyltd/vitana-v1/pulls/1639 --jq .merged` prints `true`) **and** `git grep -n "focusGuidedTopic\|GUIDED_TOPIC_TEACHING_COMPLETE" origin/main -- apps/mobile/src/orb` finds both symbols. If not, do not claim the lane; leave it `ready`.
Task list copied from `/projects/sandbox/handover-native-maxina/BACKFILL-PREP.md` §3 and the old lane; re-read every file on the new `origin/main` first. Owner-approved existing-test edit: `tests/discover-commerce/discover.test.tsx` (one assertion). Owner-approved ledger edit: one `native_only` entry in `parity/ledger.json`.
Existing test in the old lane's paths and moved at equal strength: `tests/discover-commerce/ai-picks-cold-start.test.tsx`.

- [ ] 0. Start condition above. #1639's symbols: `OrbController.focusGuidedTopic(topicId)`, `GUIDED_TOPIC_TEACHING_COMPLETE = 'vitana:guided-topic-teaching-complete'` (from `orb/ui/OrbProvider`), detail `{ topicId, reason }` through `overlayBus.on`. If their names differ on main, use main's and log it.
- [ ] 1. Red test `tests/screen-backfill/journey-bridge.test.tsx`: with no provider, `useActivateOrb()('t1')` calls the controller's `focusGuidedTopic('t1')`; emitting the teaching-complete event reaches the handler once and not after unmount; a provided `JourneyOrbBridgeContext.Provider` bridge still wins; no controller → today's fallback.
  Then `screens/journey/seams.ts`: `useJourneyOrbBridge()` returns the provided bridge, else a memoized (`useMemo` on the controller) bridge from `useOrbSession().controller`. Keep `NOOP_ORB_BRIDGE` exported and the context default; update the comments at `:14-20` and `:44-48`. `GuidedJourneyCatalog.tsx` is not touched.
- [ ] 2. Red test `tests/screen-backfill/connectors-ai-key.test.tsx`: ChatGPT and Claude Connect open `AIAssistantConnectSheet` with their provider; closing clears it; a non-AI placeholder app (`calm`) still shows `connectedApps.popup.connectionPlaceholder` (there is no second AI app: `screens/support/data/connectors.ts:117-118`; Decision taken).
  Then `ConnectorsScreen.tsx` (placeholder at `:146,181-183`): mirror web `MobileConnectedAppsView.tsx:261-264,538-543`.
- [ ] 3. Red test `tests/screen-backfill/ai-picks.test.tsx`: loading, error, empty, list; filter tabs; card press opens the product drawer; add-to-cart; back → `router.navigate('/discover')`; 11 locales without an unresolved key (pattern `discover-i18n-rtl.test.tsx`, Arabic RTL).
  Then `app/(app)/discover/ai-picks.tsx` and `src/screens/ai-picks/**`: port of the **phone** branch of web `src/pages/discover/AIPicksPage.tsx:303-437` (data `useMarketplaceFeed({ limit: 24 })`, `ProductSelectionProvider` + `ProductDetailsDrawer`, `AddToCartButton`; existing web i18n keys only; logical RTL styles; ports only).
  Then `resolve.ts`: add `'/discover/ai-picks'` to `NATIVE_ROUTES` (alphabetical, after `'/discover'`), replace the alias comment at `:65-67` with a one-line note. No `NATIVE_PATTERNS` change here.
- [ ] 4. Move `tests/discover-commerce/ai-picks-cold-start.test.tsx` to the new route at equal strength (`href: '/discover/ai-picks'`, the `?utm=x` variant keeps its query, cold start renders the new route, the `it.each` list is kept).
- [ ] 5. `tests/discover-commerce/discover.test.tsx:71`: change the single expectation to `'/discover/ai-picks'` and the title at `:65` ("… 'See all' goes to /discover/ai-picks (its own screen)"). Same matcher (`toHaveBeenLastCalledWith`).
- [ ] 6. `apps/mobile/parity/ledger.json`: add one `native_only` entry `{ "path": "/discover/ai-picks", "reason": "AI picks phone screen (app/(app)/discover/ai-picks.tsx); DISCOVER.AI_PICKS row stays /discover?tab=suggested" }`, in its own commit `chore(<VTID>): ledger native_only for /discover/ai-picks`.
  `node scripts/native/parity-ledger.mjs --check` must pass. Do not change any row status.
- [ ] 7. Verify: `npm run typecheck`; `npx jest tests/screen-backfill tests/discover-commerce tests/journey tests/support tests/ai-assistants tests/orb tests/navigation.test.tsx tests/ports.test.ts`; full `npm test`; `APP_PROFILE=development npm run bundle`; root `node scripts/native/parity-ledger.mjs --check` and `node scripts/native/core-closure.mjs --check`. Expect text conflicts in `resolve.ts` and `ledger.json` with other open native PRs: merge `origin/main`, keep both sides.

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration.
- **Outcome** — tapping a guided topic in My Journey makes Vitana teach that topic and marks it done when the lesson ends; ChatGPT and Claude in Connectors open the paste-key sheet as on web; `/discover/ai-picks` opens its own AI picks screen and the Discover "See all" button lands there.
- **States** — bridge with / without provider and controller; sheet open / closed per provider; AI picks loading / error / empty / list / filtered.
- **Surfaces** — My Journey guided catalog, Connectors, `/discover/ai-picks`, Discover "See all". Desktop: n/a.
- **Locales** — existing web keys (`discover.aiPicks.*`, `discover.filters.*`, `connectedApps.*`); 11-locale test for AI picks; Arabic RTL with logical styles.
- **Accessibility** — AI picks back button, tabs and cards have accessible names and ≥ 44 pt targets.
- **Contract** — ORB controller `focusGuidedTopic` and the bus event from #1639; AI key calls as #1584; marketplace feed as `screens/discover/data/marketplace.ts:121`; ledger rule d of `parity-ledger.mjs:249-256` satisfied by the `native_only` entry.
- **Staging proof** — not verified on staging (no native staging deploy; G1 pending); covered by `npx jest tests/screen-backfill tests/discover-commerce`.
- The only existing tests changed are `ai-picks-cold-start.test.tsx` (moved at equal strength) and `discover.test.tsx` (one expectation + title); `ledger.json` gains exactly one `native_only` entry and no row changes; new tests red on the post-#1639 `origin/main`; no file outside `paths`; NATIVE-CI, **Collab handoff**, **Lane scope** green.
