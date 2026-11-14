---
change_class: standard
---
# Plan — native-followups-20261111
Author: Kiro, seat `exafyltd`. Repo of the code: `exafyltd/vitana-v1` (native app `apps/mobile/**`, two web i18n files under `src/i18n/`,
`docs/validation/**`). This spec lives in `exafyltd/vitana-platform`. No gateway change, no migration, no `packages/core` change, no
protected gate file. Program: `docs/programs/native-app/program.md` (`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md`, VTID-05021).

<!-- plan:begin -->
## Goal
Owner instruction, verbatim:

> "Test-key edits for #1645 (tests/shell.test.tsx:49, tests/identity.test.tsx:149): approved. Fix useMyPartnerOrgs.ts:23 in the same change. Backfill: may add discover.test.tsx (1 assertion) and ledger.json (1 entry). Deep link /comm/my-groups/:id: one follow-up lane, with the one pin change in routes.test.tsx listed in its PR. i18n-rtl.test.tsx: open a fix lane. Make the test deterministic. Do not weaken or skip assertions. Translations: fix the two empty Turkish strings and the German "Sie" in the locale files. If a test asserts the old string, list it for approval and do not edit it. Push provider: align the real client (registration.ts:108) to the spec."

Five lanes are buildable. Two parts of the instruction are **not buildable as written** and are held back with evidence (see
"Held back — needs the owner"): the German "Sie" string (two existing tests pin it, and one of them records an owner decision) and
the push body (the real client already matches the gateway; the mismatch is in the test fixture).

Pinned: vitana-v1 origin/main `f2d652001bbf1415f19439f2d5c454e3ca8662e3`, vitana-platform origin/main `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` (2026-11-11T12:25Z).
Every `vitana-v1:` reference below was read with `git show f2d652001:<path>`.

## Measured state (at the pin)

### 1. `partner-orgs-path`
- `vitana-v1:apps/mobile/src/identity/useMyPartnerOrgs.ts:23` calls `gatewayGet('/api/v1/partner-orgs/mine')`.
- `gatewayGet` goes through `createGatewayFetch` (`apps/mobile/src/auth/gateway.ts:14,23-25`), which prefixes `/api/v1` itself
  (`packages/core/src/gateway.ts:6,22` → `gatewayApiUrl`, `packages/core/src/config.ts:21-25`). The real URL is therefore
  `<origin>/api/v1/api/v1/partner-orgs/mine` (doubled). Same defect, same cause as `GuidedModeProvider.tsx:71`, which open PR
  #1645 (VTID-05647, lane `native-shell-fixes-r2/shell-fixes`) fixes. #1645's test says why it left this hook out
  (`tests/shell-fixes/gateway-paths.test.tsx` header: the fixtures at `tests/shell.test.tsx:49` are keyed on the doubled path).
- The fixtures key the fake gateway on the doubled path: `tests/shell.test.tsx:49` and `tests/identity.test.tsx:149`. The fake
  gateway matches the exact path string it is given (`tests/helpers/providers.tsx:24-31`), so these two keys must become
  `/partner-orgs/mine` in the same change or both tests go red. These are the two owner-approved test edits (key only).
- Two more fixtures use the doubled key with an empty list: `tests/professional/bottom-tabs.test.tsx:31` and
  `tests/staff/chrome.test.tsx:26`. They are **not** edited. After the fix the fake answers 404 for the old key; `useMyPartnerOrgs`
  then has `data === undefined` and `useBusinessMode` falls back to `EMPTY` (`src/identity/useBusinessMode.ts:15-17`), the same
  result as `organizations: []`. The lane must run both and show they stay green; they remain stale fixtures (listed, not edited).
- **Overlap with lane `native-shell-fixes-r2/shell-fixes` (VTID-05647), stated exactly.** That lane file *declares* `apps/mobile/src/identity/useMyPartnerOrgs.ts` and
  `apps/mobile/tests/identity.test.tsx` in its `paths` (`.kiro/specs/native-shell-fixes-r2/lanes/shell-fixes.md:12,21`) and its plan intended to fix both
  (`native-shell-fixes-r2/plan.md:29,55,77`). Its open PR #1645 does **not** edit them: `gh api repos/exafyltd/vitana-v1/pulls/1645/files` lists only `GuidedModeProvider.tsx`,
  `AuthGate.tsx`, `tests/shell-fixes/{auth-gate,gateway-paths}.test.tsx` and `docs/validation/VTID-05647/*`; its builder left the hook out because fixing it turns
  `tests/shell.test.tsx:49` red and that file was outside the lane (`gateway-paths.test.tsx` header). Neither of the three files of this lane is touched by #1645 today.
  `tests/shell.test.tsx` is in no other lane.
- **Coordination (option c of sparring R1-F1).** `partner-orgs-path` takes over those edits from `shell-fixes`: the owner's instruction names the test-key edits and the hook fix as a
  follow-up to #1645 and approves them here. The `shell-fixes` lane file is another plan's file and a `_plan` commit may not edit it, so it keeps its declared paths unchanged;
  the handoff is recorded in this plan and in the `partner-orgs-path` lane log. Ordering rule, checked by the lane at claim time and again before the PR: if #1645's file list
  (or its merged diff) contains `useMyPartnerOrgs.ts`, `tests/identity.test.tsx` or `tests/shell.test.tsx`, this lane stops, merges `origin/main` and does only what is left; it never
  re-applies an edit already on main. Whichever PR merges second takes a trivial conflict only on the one changed line.

### 2. `my-groups-deeplink`
- `apps/mobile/app/(app)/comm/my-groups/[id].tsx` renders `GroupDetailScreen` (ledger row `/comm/my-groups/:id`, `status: native`,
  `apps/mobile/parity/ledger.json:2465-2474`; web `src/App.tsx:1236`).
- `resolveWebPath('/comm/my-groups/g-1')` is `unported`: the path is in neither `NATIVE_ROUTES` nor `NATIVE_PATTERNS`
  (`apps/mobile/src/navigation/resolve.ts:154`, checks at `:199-200`). Evidence: vitana-v1 PR #1657 (VTID-05685)
  `docs/validation/VTID-05685/findings.md` finding 4, and `handover-native-maxina/PARITY-AUDIT.md` §4. Deep links and the ORB treat the
  route as unported although in-app navigation reaches the file.
- `NATIVE_ROUTES` must equal the concrete route files (`tests/navigation.test.tsx:67-84` skips every `[param]` file), so the dynamic
  route belongs in `NATIVE_PATTERNS`, exactly like `/discover/provider/:id`.
- One existing test pins `NATIVE_PATTERNS`: `tests/discover-commerce/routes.test.tsx:117-120` (`toEqual(['/discover/provider/:id'])`). No other test
  references `NATIVE_PATTERNS` (`git grep NATIVE_PATTERNS`: `resolve.ts` and that file only). This is the one pin change.
- #1657 adds route tests that deliberately do not assert `resolveWebPath` for this path; no overlap with this lane's files.

### 3. `i18n-rtl-deterministic`
- `apps/mobile/tests/settings/i18n-rtl.test.tsx`: 11 locales × (8 modes + 1) renders plus the Arabic test; `jest.setTimeout(30000)` at `:26`.
- Failure captured from a CI log of a vitana-v1 PR run (`/projects/sandbox/.agents/tmp/sh-ci2.log:27139` `FAIL tests/settings/i18n-rtl.test.tsx (15.814 s)`;
  failing test `Arabic renders right-to-left with the Arabic catalog`, error `Unable to find node on an unmounted component` at
  `tests/settings/i18n-rtl.test.tsx:103:65`, stack through `toHaveTextContent`). Passing runs of the same file take 12.5–27.8 s
  (`sh-ci.log:29032`, `cal-full.log:35686`, `d2-full.log:25362`); a loaded full run took 78 s and failed (`bh2/checks.log:10`).
- Cause in the test, not in the app: `:103` does `expect(await screen.findByTestId('tenant-role-current-role')).toHaveTextContent(...)`.
  `findByTestId` returns one element instance; the matcher then reads it after React has re-rendered or replaced that node (the screen swaps a
  loading skeleton for content, `src/screens/settings/TenantRoleScreen.tsx:150-176`, and the role text is computed from async data), so under load
  the held reference is already unmounted. The 11-locale loops (`:60-80`) hold elements across awaits the same way
  (`await screen.findByTestId(...)` then a separate `getByTestId`), only less often.
- No open PR edits this file.

### 4. `translations`
- `src/i18n/tr/screens.json:6777` `screens.profile.dancePreferences` = `""`, `:8145` `screens.sharing.stressLevels` = `""`. These are the only two empty
  strings in that file (`grep -c '": ""'` = 2). Sources: de `src/i18n/de/screens.json:6641` "💃 Tanzvorlieben", `:7982` "Stresslevel"; en `:6641`
  "💃 Dance preferences", `:7985` "Stress Levels". Used at `src/components/profile/sections/DancePublicSection.tsx:61` (`t('screens.profile.dancePreferences')`).
  The existing Turkish catalog already says "Dans tercihleri" for the same concept (`src/i18n/tr/toasts.json:865`).
- German: `src/i18n/de/screens.json:11058` `screens.commerceportal.terms.agreeExplanation` uses "Sie" ("bestätigen Sie, dass Sie berechtigt sind"). **Two existing tests pin it**:
  - `src/components/commerce/PartnerTermsSheet.vtid-04909.test.tsx:92` asserts the text contains `bestätigen Sie, dass Sie berechtigt sind`.
  - `src/lib/commerce-terms.vtid-04895.test.ts:115-118` ("de is du-form, except the contractual acceptance and binding notice (owner decision 2026-10-06)") asserts
    the formal-address keys of the German terms are exactly `['agreeExplanation']`. A du-form rewrite makes that list `[]` and the test red.
  Per the owner instruction the German change is **not in any lane's paths**. It is listed below under "Held back".
- Other users of the three keys outside `src/i18n`: none besides `DancePublicSection.tsx`. No test in `src/**` or `apps/mobile/tests` asserts the Turkish values.
- Open PRs touching `src/i18n/tr/screens.json`: #1605 (adds four keys around `:11245`, a different region; merge conflict is not expected).

### 5. Push provider — premise does not hold (no lane)
- `vitana-v1:apps/mobile/src/push/registration.ts:108` (the real client) posts `{ fcm_token, device_type: 'ios_native'|'android_native', app_version }`.
- The gateway route that receives it, `vitana-platform:services/gateway/src/routes/notifications.ts:62-76`, requires `fcm_token` (`:66-69`, 400 otherwise) and reads `device_type`
  and `app_version` through `resolveNativeDevice` (`:36-51`: only `ios_native`/`android_native` accepted). The program plan agrees
  (`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:161`) and the real-client test pins it (`apps/mobile/tests/push-registration.test.ts:106`).
  So the real client already matches the gateway contract.
- The body that does not match is `apps/mobile/src/push/g1-test-provider.ts:107` `{ token, device_type }`, which posts to the local **fixture** gateway
  (`apps/mobile/tools/fixture-gateway/server.js:172-174`: `token` and `device_type: 'ios'|'android'`), documented as deliberate (`g1-test-provider.ts:17-20`,
  `tools/fixture-gateway/README.md:13`). Against the real gateway that body would answer 400.
- Changing `registration.ts:108` to the fixture's shape would make the real client fail against the real gateway and turn `tests/push-registration.test.ts:106` red. Not planned.

### 6. `screen-backfill`
- Same work as lane `native-wave2-fix-forward-r2/screen-backfill` (VTID-05651): `.kiro/specs/native-wave2-fix-forward-r2/lanes/screen-backfill.md` (paths) and
  `/projects/sandbox/handover-native-maxina/BACKFILL-PREP.md` (task list, measured at `e31bf4627`; re-verified at the pin below).
- Still true at `f2d652001`: `screens/journey/seams.ts:14-20,54-62` (no-op bridge; no `focusGuidedTopic` in `src/orb` yet: `git grep focusGuidedTopic -- apps/mobile/src` finds only `seams.ts`);
  `screens/support/ConnectorsScreen.tsx:146,181-183` (placeholder for ChatGPT/Claude, `AIAssistantConnectSheet` not imported); `app/(app)/discover/ai-picks.tsx` and
  `src/screens/ai-picks/` absent; `resolve.ts:65-68` (alias comment above `'/discover'`).
- Start condition not met today: vitana-v1 PR #1639 (`native-wave2-fix-forward-r2/orb-guided-topic`, VTID-05649) is `open`, `merged: false`, head `ce9344436`.
- The two approved path additions are required, not optional (BACKFILL-PREP §0): once `/discover/ai-picks` is a native route,
  `tests/discover-commerce/discover.test.tsx:71` (`toHaveBeenLastCalledWith('/discover?tab=suggested')`, title at `:65`) goes red; `scripts/native/parity-ledger.mjs --check`
  (rule d, `:249-256`) needs a row of shape `/discover/ai-picks` — the only AI-picks row is `DISCOVER.AI_PICKS` with `web_path: "/discover?tab=suggested"`
  (`apps/mobile/parity/ledger.json:929-930`) — or a `native_only` entry (`ledger.json:4-21`).

## Decisions
1. **Five lanes, no shared file except the documented hot ones.** `resolve.ts` is edited by `my-groups-deeplink` (`NATIVE_PATTERNS`) and by `screen-backfill` (`NATIVE_ROUTES`);
   `screen-backfill` therefore `depends_on: [my-groups-deeplink]` (collaboration §8a: hot files are sequenced). `ledger.json` is edited only by `screen-backfill`.
2. **`partner-orgs-path` fixes the code at `:23` and the two fixtures in one PR** because the fixtures go red the moment the path is right (owner: "in the same change").
   Key-only edits: line 49 and line 149, nothing else in those files. Ownership of those files relative to the `shell-fixes` lane: see "Overlap" in Measured state §1.
3. **`my-groups-deeplink` uses `NATIVE_PATTERNS`, not `NATIVE_ROUTES`**, because `tests/navigation.test.tsx:67-84` ties `NATIVE_ROUTES` to concrete files. The pin test changes from
   `toEqual(['/discover/provider/:id'])` to `toEqual(['/discover/provider/:id', '/comm/my-groups/:id'])` and its title is updated; the second assertion
   (`resolveWebPath('/discover/provider').kind` not native) stays. The PR body lists this one change.
4. **`i18n-rtl-deterministic` keeps every assertion.** The fix is in how the test waits: re-query inside `waitFor`, so the matcher always reads the node that is mounted now;
   no element reference is held across an await; per-locale renders unmount before the next (`cleanup`), fake timers are not needed unless the red-on-base run shows a timer cause. Raising a timeout is allowed only as an addition,
   never as the fix.
5. **`translations` fixes Turkish only.** Values: `dancePreferences` → "💃 Dans tercihleri" (same wording as `tr/toasts.json:865`; the emoji is kept as in the de and en source), `stressLevels` → "Stres seviyeleri" (both are noun phrases and carry no formal or informal address,
   so the informal-register requirement is met by construction). A new test fails on base because both strings are empty.
6. **`screen-backfill` supersedes VTID-05651's lane.** When this plan's lane gets its VTID, the old lane (`native-wave2-fix-forward-r2/screen-backfill`, VTID-05651) is superseded; nothing is built under it.
   Its `paths` are kept (including the existing `tests/discover-commerce/ai-picks-cold-start.test.tsx`, which the old plan already approved and which moves to the new route at equal strength) plus the two owner-approved additions.
7. **No lane for the push body** (premise wrong, above). **No German edit** (tests pin it, above).

## Lanes
| Lane | Repo | Scope | depends_on | Status |
|---|---|---|---|---|
| `partner-orgs-path` | vitana-v1 | `useMyPartnerOrgs.ts:23`; key at `tests/shell.test.tsx:49`; key at `tests/identity.test.tsx:149`; new `tests/followups/partner-orgs/**` | — | buildable |
| `my-groups-deeplink` | vitana-v1 | `resolve.ts` `NATIVE_PATTERNS`; pin in `tests/discover-commerce/routes.test.tsx`; new `tests/followups/my-groups/**` | — | buildable |
| `i18n-rtl-deterministic` | vitana-v1 | `tests/settings/i18n-rtl.test.tsx` only | — | buildable |
| `translations` | vitana-v1 | `src/i18n/tr/screens.json` (2 values); new `src/i18n/tr-screens-no-empty-values.test.ts` | — | buildable (Turkish only) |
| `screen-backfill` | vitana-v1 | old lane's paths + `tests/discover-commerce/discover.test.tsx` (1 assertion) + `parity/ledger.json` (1 `native_only` entry) | `my-groups-deeplink` (hot file) + start condition #1639 merged | buildable only after #1639 merges |

Parallel: the first four run at once. `screen-backfill` waits for `my-groups-deeplink` and for #1639.

## Held back — needs the owner (not in any lane)
1. **German "Sie" in `screens.commerceportal.terms.agreeExplanation`** (`src/i18n/de/screens.json:11058`). Two existing tests assert the old string and one records an owner decision of 2026-10-06 that this acceptance sentence stays formal:
   `src/components/commerce/PartnerTermsSheet.vtid-04909.test.tsx:92` and `src/lib/commerce-terms.vtid-04895.test.ts:115-118`. Per the instruction they are not edited. To proceed the owner approves, in one answer:
   (a) overriding the 2026-10-06 decision, (b) the new text — proposed: "Mit dem Aktivieren dieses Kontrollkästchens und dem Klick auf „Akzeptieren“ bestätigst du, dass du berechtigt bist, im Namen des Partners zu handeln, und dass diese Partnerbedingungen für den Partner verbindlich sind." —
   and (c) editing those two tests (`:92` expected substring → `bestätigst du, dass du berechtigt bist`; `:118` expected list → `[]` and the title). Then one more lane (`src/i18n/de/screens.json` + those two tests) is a small follow-up. The other Turkish/other-locale formal wording of the same sentence is not in the instruction and is left as is.
2. **Push body.** Premise corrected in "Measured state" §5. If the owner still wants the fixture and the test provider to speak the real gateway shape (`fcm_token`, `ios_native`/`android_native`, optional `app_version`), that is a different change: `apps/mobile/tools/fixture-gateway/server.js:172-174`, `tools/fixture-gateway/README.md:13`, `src/push/g1-test-provider.ts:107` (+ `deviceType` at its `:35-40`),
   and existing tests that pin the fixture shape and need owner approval: `tests/fixture-gateway/server.test.ts:156-175`, `tests/g1-smoke/push.test.ts:55-66`. Not planned here; changing `registration.ts:108` is **not** the fix.

## Tests and verification
- Every lane runs `cd apps/mobile && npm ci && npm test && npm run typecheck` (the translations lane runs the root `npm test` for the web test files it touches: `npx vitest run src/i18n src/lib/commerce-terms.vtid-04895.test.ts src/components/commerce/PartnerTermsSheet.vtid-04909.test.tsx`).
- New tests are recorded red on base in `docs/validation/<VTID>/red-on-base.txt` and `commands.log`.
- No native staging deploy exists; each lane records `not verified on staging: <reason>` and names its covering test. No lane writes to Supabase, AWS or any live system.

## Measurement
`docs/validation/<plan VTID>/timings.json` per collaboration §8b. Flake check for `i18n-rtl-deterministic`: the file is run 5 times in a row and 3 times under artificial CPU load; the counts go in the lane's `verification.md`.

## Risks
- `resolve.ts` and `ledger.json` collide with the open native PRs (#1587 #1604 #1608 #1619 #1620 #1623 #1634 #1636 #1646 #1647); additive edits, keep both sides on merge.
- The Arabic test may have a second cause under load that only shows in a full-suite run; the lane reproduces it before fixing and says so if it cannot.
- `screen-backfill` is large (journey bridge, Connectors sheet, AI picks screen); it may need the fix-forward budget of three attempts, then it parks.

## Unchanged
Every existing assertion in the touched test files, the sidebar and ORB chrome, the Spotlight contract, the i18n rules (du-form), the parity method, the production guards in `app.config.ts`/`env.ts`,
and the rule that no native build or test touches production.
<!-- plan:end -->
