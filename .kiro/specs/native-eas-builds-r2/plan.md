# Plan — native-eas-builds-r2
Author: Kiro, seat `exafyltd`. Repo of the code: `exafyltd/vitana-v1` (`apps/mobile/`, `scripts/native/`,
`.github/workflows/`). Spec folder: `exafyltd/vitana-platform` (`.kiro/specs/native-eas-builds-r2/`), the same
arrangement as `native-g1-wiring`. Programme: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), Wave 0
setup (row 0, "Expo project + CI (EAS or GitHub macOS runners)") and Wave 3 (row 3, "internal + TestFlight/closed
track"). Spec files: `handoff.md`, `tasks.md`, `lanes/*.md` in this folder.

Lines marked `vitana-v1:` are in `exafyltd/vitana-v1`. Lines marked `vitana-platform:` are in this repo. Unqualified
citations are vitana-v1 `origin/main`, pinned at `a763b4f01` (re-verified in sparring round 1; the plan was drafted at
`663d09a34`, and every vitana-v1 citation below is unchanged between the two).

<!-- plan:begin -->
Re-plan note (2026-11-08T11:48Z): this is the plan of `native-eas-builds` (PR #4771) under a new slug, because the old branch carries `_plan` commits from two Kiro sessions (the original author and the session that answered its sparring), which Collab handoff refuses for a `_plan` lane. Content is the version drafted there plus the round-1 corrections of session `34722f39` (sparring round 1 was open there, not converged; the corrections were committed locally and never pushed); unchanged except the slug.

## Goal
Build the existing wrapper app, the Maxina app, as native iOS and Android binaries through Expo Application Services
(EAS), for the two profiles that exist today, `development` and `test-g1`, and deliver them to the internal test
audience: TestFlight internal testing on iOS and the Play internal testing track on Android. Every build and upload
is a routine pipeline step. Every input that only the owner can provide (Apple, Google and Expo accounts, store
identifiers, signing keys, tester lists, and G1) is listed under "Owner-gated inputs" and is not guessed. No
production profile is added: it waits for gate G3 and an owner decision (`NATIVE-APP-PLAN.md` §2a G3, §8).

## Measured state (origin/main)
- `vitana-v1:apps/mobile/eas.json` (merged earlier through `native-g1-wiring` `build-profiles`, VTID-05247) defines
  exactly two profiles: `development` (`developmentClient: true`, `distribution: internal`,
  `APP_PROFILE=development`, lines 7-12) and `test-g1` (`distribution: internal`, `APP_PROFILE=test-g1`, lines 14-18).
  There is no `production` profile, no `submit` block, and no credential field.
- `vitana-v1:apps/mobile/app.config.ts:32-39` (`resolveProfile`) throws for an unset profile and for `APP_PROFILE=production`
  ("native builds never point at production", VTID-05157). This is the runtime guard; the build profile list is the
  build-time one.
- `vitana-v1:.github/workflows/NATIVE-CI.yml` runs on `ubuntu-latest`, and its script-test step runs
  `node --test scripts/native/__tests__/*.test.mjs` (lines 263-264). A new `*.test.mjs` file there is picked up
  without touching the workflow.
- No EAS build, submit, or store workflow exists. `vitana-v1:apps/mobile/` has no `ios/` or `android/` folder
  (prebuild is not run in CI).
- `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md`: G1 isolated test environment §2a line 100; G3 store and
  signing ownership line 118 (App Store Connect team `62Q26QSEJW`, Play Console, Android app-signing/upload key,
  "within 2 weeks", contingency: new listings with new identifiers plus an in-app migration notice); Wave 0 row line
  195; Wave 3 row line 199; §6 verification and safety line 204 ("native dev/beta builds point at G1").
- `vitana-v1:apps/mobile/README.md` lines 99-107, "What waits for which gate": native builds wait for STATUS row 8b
  (macOS minutes for iOS) and G1 for signed-in screens; store identifiers, signing and store listings wait for G3.
- `vitana-platform:docs/programs/health-hub/STATUS.md` row 7 (G3, "waiting", owner: App Store Connect / Play Console
  access) and row 8 (Wave 0, "queued", "macOS build minutes (EAS or GitHub)").
- vitana-v1 has no copy of `queue.mjs` or `protected-gate-files.json` (`git ls-tree` of `origin/main` finds none).
  Its `PR-GATE.yml:81-95` fetches the single platform copy from `exafyltd/vitana-platform@main` and runs
  `queue.mjs validate`, so the governance and protected-gate lists below apply to vitana-v1 lane PRs unchanged and
  cannot diverge.
- No workflow catalog applies to the two new workflows. The only catalog is `vitana-platform:services/gateway/specs/loop-catalog-v1.json`;
  its CI test `vitana-platform:services/gateway/test/loop-catalog.test.ts:44-46` lists `.github/workflows` of the
  platform checkout and keeps only files with a `schedule:` trigger. `NATIVE-EAS-BUILD.yml` and `NATIVE-EAS-SUBMIT.yml`
  are `workflow_dispatch`-only, live in vitana-v1, and have no schedule, so no registration is needed. vitana-v1
  `origin/main` has no loop-catalog file (`git ls-tree` finds none).
- Governance check (`vitana-platform:scripts/collab/queue.mjs:86`): `.github/**` is a governance path. It is not in
  `vitana-platform:scripts/collab/protected-gate-files.json`, so a Kiro lane may change a new
  `.github/workflows/NATIVE-EAS-*.yml` if its `reviewer_seat` is `agent:vitana-lane-reviewer`. The lane does not need
  `executor: claude`, and Claude Code is retired for this purpose.

## External facts (vendor docs, checked 2026-11-07)
- Expo Submit uploads an iOS `.ipa` to App Store Connect. The build appears in TestFlight after processing, which
  takes about 10-15 minutes (`docs.expo.dev/submit/ios/`). Internal TestFlight testing needs only a group in App
  Store Connect. External testing needs Beta App Review for the group's first build (`docs.expo.dev/submit/testflight/`).
- For a new Android app, `eas submit` creates the first release on the internal testing track by itself. A manual
  first upload in Play Console is optional (`docs.expo.dev/deploy/submit-to-app-stores/`).

## Decisions (each decided by Kiro, with the reason)
1. **Build service: EAS cloud builds for iOS and Android.** Reason: an iOS archive needs macOS. EAS runs its own macOS
   workers, so the GitHub job that starts a build runs on `ubuntu-latest` and uses no macOS minutes. The programme
   row 8 accepts "EAS or GitHub". Rejected as the first choice: GitHub macOS runners with `expo prebuild` and
   `xcodebuild`. That needs macOS minutes and the Apple signing identities inside CI secrets from day one. Cost of the
   chosen route: EAS plan and build credits (owner-gated input O1).
2. **Device builds only in this plan.** iOS and Android artefacts are device builds (`development` and `test-g1`,
   internal distribution). Simulator builds for Maestro and screenshot parity are not added. They need a profile
   change and belong to the Maestro lane when that is planned. The "simulators" row of the README gate table stays with
   that lane.
3. **Credentials never enter the repository.** The Expo token is a GitHub Actions secret (`EXPO_TOKEN`) and nothing
   else. Apple and Google credentials live in EAS managed credentials or in the EAS submit configuration. `eas.json`
   holds no secret path, key, password, token or team secret. Store identifiers (iOS bundle identifier, App Store
   Connect app id, Android package name, Play track) are not secrets and may appear in `eas.json`. The
   `eas-profile-guard` test enforces both halves. **Play service-account key:** the owner uploads it once to EAS
   managed credentials (`eas credentials`, O3). The submit workflow therefore needs no key file, no
   `serviceAccountKeyPath` in `eas.json` and no extra GitHub secret; `eas submit` reads it from EAS using `EXPO_TOKEN`.
   If the owner chooses not to store it in EAS, the lane stops and returns to planning; it may not add the key path
   to `eas.json` (the guard would fail it) or a new secret on its own.
4. **Apple: no device build before O2.** Every iOS device build, including internal distribution, needs an Apple
   Developer membership and provisioning, so the first iOS cloud build waits for O2. The bundle identifier must be
   chosen by the owner before the first upload, because it cannot change afterwards.
5. **Android: internal builds do not wait for the Play account.** An internal Android build can use an EAS-managed
   keystore without a Google account. The Play upload key is the owner's G3 input (O3), and whether it is EAS-managed or
   exported is the owner's choice. Only the Play submit lane waits for O3.
6. **Profiles: `development` and `test-g1` only. No `production` profile and no `submit.production`.** Reason:
   mirrors the runtime guard (`app.config.ts:32-39`) and `NATIVE-APP-PLAN.md` §6. A production profile is a later owner
   decision after G3 (O6). `eas-profile-guard` fails the build if one appears.
7. **Submit scope: `test-g1` only, internal tracks only.** iOS uploads reach App Store Connect and then the internal
   TestFlight group only. Android uploads go to the Play internal testing track (`track: internal`). External
   TestFlight (needs Beta App Review) and any Play track above internal are out of this plan. The submit workflow
   refuses any other profile or track.
8. **Triggers: manual `workflow_dispatch` only.** Nothing builds or uploads on push or merge. Builds cost EAS credits,
   and an upload reaches testers. The dispatch is a routine pipeline step for Kiro (`collaboration.md` §7d), and the
   owner names the tester groups (O5).
9. **test-g1 builds point at G1, which does not exist yet.** The `test-g1` profile reads placeholder hosts
   (`native-g1-wiring`, `apps/mobile/env/test-g1.example.json`). Until G1 is provisioned (`native-g1-wiring`
   `real-g1-switch`, owner), a `test-g1` build installs and opens, but signed-in screens cannot run. Uploading a
   `test-g1` build to testers therefore waits for O4. This is a dependency on another spec, so it cannot be expressed
   in `depends_on` and is listed here as an external gate.
10. **No manual first Play upload is needed.** See "External facts". The Play submit lane still needs the Play account,
   the upload key and the service account (O3).

## Owner-gated inputs (the owner provides these; Kiro never guesses them)
| # | Input | Gate | Blocks |
|---|---|---|---|
| O1 | Expo account, the `EXPO_TOKEN` GitHub secret on `vitana-v1`, and the EAS plan with its build-credit budget. Confirm that this belongs to G3. | G3 (not in the README gate table; owner confirms) | first run of `eas-build-workflow` |
| O2 | Apple: confirm access to App Store Connect (team `62Q26QSEJW`) and an Apple Developer membership; choose the iOS bundle identifier (cannot change later); create the App Store Connect API key and give it to EAS; create the app record. | G3 (`NATIVE-APP-PLAN.md:118`) | first iOS device build; `eas-submit-workflow` iOS |
| O3 | Google: confirm Play Console access; choose the Android package name (cannot change later); decide whether the Play upload key is EAS-managed or exported; create the Play service account with the API access and give its key file to EAS. | G3 (Play Console; Android app-signing/upload key) | `eas-submit-workflow` Android |
| O4 | Provision G1 (the `real-g1-switch` step of `native-g1-wiring`). | G1 (`NATIVE-APP-PLAN.md:100`) | any `test-g1` upload to testers that is meant to sign in |
| O5 | Name the tester groups: the App Store Connect internal TestFlight group and the Play internal testers list (staff and volunteers, Wave 3). | G3 / Wave 3 | the first upload to testers |
| O6 | Decide whether and when a `production` profile exists. | G3 + owner decision (`NATIVE-APP-PLAN.md` §8) | nothing in this plan |

**Schedule risk to raise with the owner.** The 2-week window of G3 (`NATIVE-APP-PLAN.md:118`) was written against the
2026-10-10 baseline. By the document's own timing it lapsed around 2026-10-24. STATUS row 7 still reads "waiting".
The contingency (new listings with new identifiers, plus an in-app migration notice in Appilix) is an owner decision
that is now due. This plan does not take it. The lanes below need O1-O3 whichever way the owner decides, but the
identifiers that O2 and O3 fix depend on that decision.

## Lanes (all `ready`; no `vtid` until CI assigns it)
| Lane | Executor / seat → reviewer | Scope (vitana-v1 unless noted) | depends_on | next_actor |
|---|---|---|---|---|
| `eas-profile-guard` | kiro / exafyltd → agent:vitana-lane-reviewer | `scripts/native/eas-profile-guard.mjs`, `scripts/native/__tests__/eas-profile-guard.test.mjs` | — | kiro |
| `eas-build-workflow` | kiro / exafyltd → agent:vitana-lane-reviewer | `.github/workflows/NATIVE-EAS-BUILD.yml` | eas-profile-guard | kiro |
| `store-owner-gate` | kiro / exafyltd (owner records only) | `docs/validation/g3/**` | — | **owner** |
| `eas-submit-workflow` | kiro / exafyltd → agent:vitana-lane-reviewer | `.github/workflows/NATIVE-EAS-SUBMIT.yml`, `apps/mobile/eas.json` (the `submit` block only) | eas-build-workflow, store-owner-gate | kiro |
| `native-eas-runbook` | kiro / exafyltd → agent:vitana-lane-reviewer | `apps/mobile/README.md` (new "EAS builds and store uploads" section) | eas-build-workflow, eas-submit-workflow | kiro |

Path ownership: no path is in two lanes. `eas-profile-guard` reads `apps/mobile/eas.json` but does not change it, so
`eas-submit-workflow` is the only lane that edits it. Each code lane also adds
`docs/validation/VTID-*/scope.json`, `docs/validation/VTID-*/staging-tests.json` and
`docs/validation/VTID-*/plan-sparring.md`, which are the lane's own VTID folder. `store-owner-gate` has no code and
no VTID folder: it owns `docs/validation/g3/**` only. Nothing in this plan touches `NATIVE-CI.yml`,
`apps/mobile/src/**` or the parity ledger.

Notes:
- `eas-profile-guard` runs in the existing `NATIVE-CI.yml` script-test step (`scripts/native/__tests__/*.test.mjs`).
  It needs no workflow change.
- `eas-build-workflow` and `eas-submit-workflow` are not required checks. They are dispatched by hand, so the owner can
  watch them and they do not block merges.
- `store-owner-gate` has no code. The owner records the O2 and O3 outcomes (for example "API key stored in EAS: yes")
  in `docs/validation/g3/`. The record never contains a key, token or secret value.
- `eas-submit-workflow` depends on `store-owner-gate`. Its first real upload also needs O4 and O5 (Decision 9).

## Test plan
- `eas-profile-guard`: `node --test scripts/native/__tests__/eas-profile-guard.test.mjs` (also run by NATIVE-CI). Cases:
  the current `eas.json` passes; a `production` profile fails; a `submit.production` block fails; a secret-like key
  (`EXPO_TOKEN`, `serviceAccountKeyPath`, `keystorePath`, `password`, `p8`, `*Secret`, `*Token`) fails; a profile
  whose `APP_PROFILE` is not `development` or `test-g1` fails; a `submit` block with a track other than `internal`
  fails. Mutation check: each rule broken once in a scratch copy must turn the test red.
- `eas-build-workflow`: YAML parse of the file; the input choices are only `development`/`test-g1` and `ios`/`android`;
  no `secrets.` in an `if:`; then one manual dispatch with `test-g1` + `android`, verified by the EAS build URL and the
  build status in the run log. iOS run after O1 and O2.
- `eas-submit-workflow`: the workflow refuses any profile other than `test-g1` and any track other than `internal`
  (a dry check in the workflow's first step, tested by a dispatch with a bad input). Then one real upload to internal
  tracks after O3-O5. Verified by the App Store Connect build appearing in TestFlight and by the Play internal release
  appearing with its version code.
- `native-eas-runbook`: markdown links resolve; the README "What waits for which gate" table stays consistent with the
  owner-gated list here.
- No suite targets production. Store uploads go only to the internal groups named in O5, and no test writes to
  `gateway.vitanaland.com`, Supabase, or any live member-facing system.

## Verification and what "done" means
Per `.kiro/pipeline/quality-checks.md` ("What verified means"): a non-deploying native change is verified on the real
artifact it changes. For this plan that means an EAS build with a finished artefact URL, a TestFlight build or Play
internal release that appears in the store with the right version, and the build installing and opening on a tester's
device. Until O1-O5 are in place, the lanes end at "merged, workflow dispatched once, blocked on owner input". Each
blocked item is reported with its O-number.

Staging proof: "not verified on staging: native app has no staging deploy; proven on the EAS artefact and the store
internal track."

## Measurement
Each plan run writes `docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`), as `pipeline-speed` requires.

## Out of scope and unchanged
- No production profile, no PUBLISH, no store production release, no external TestFlight, no Play track above internal.
- No Maestro or simulator build (Decision 2), no parity ledger change, no `src/**` change, no `NATIVE-CI.yml` change.
- No `vitana-platform:docs/programs/health-hub/STATUS.md` edit in this plan. Row 8 is updated when the first lane
  merges (a separate lane in the programme owner's scope), because a lane may have one repo only.
- No change to the G1 or G2 plans. G2 (push and Firebase, `google-services`) waits for its own plan.
- No VTID is allocated here. CI PLAN-SPAR allocates after convergence.
<!-- plan:end -->
