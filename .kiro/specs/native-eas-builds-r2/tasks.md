# Tasks — native-eas-builds-r2

Authoritative plan: `plan.md`. One PR per lane, branch `kiro/native-eas-builds-r2/<lane-id>`, title
`VTID-xxxxx (native-eas-builds-r2/<lane-id>): …`, trailers `Collab-Session` and `Collab-Lane: native-eas-builds-r2/<lane-id>`.
VTIDs are assigned by CI after PLAN-SPAR converges; do not start a lane before its `vtid:` is set. Lanes change only
their `paths`. Code lanes run `node --test scripts/native/__tests__/*.test.mjs` and `cd apps/mobile && npm test`, and
add `docs/validation/<VTID>/{scope.json, staging-tests.json, plan-sparring.md}` (`staging-tests.json` read-only).

<!-- lane: eas-profile-guard -->
## Lane `eas-profile-guard` (vitana-v1)
- [ ] G1 Write `scripts/native/__tests__/eas-profile-guard.test.mjs` and `scripts/native/eas-profile-guard.mjs` for the
  rules of plan Decisions 3 and 6: profiles exactly `development` and `test-g1`; no `production` key; no secret-like key;
  `submit`, if present, only `test-g1` with `track: internal`. Record the test red on `origin/main` with a copy of
  `eas.json` that has a `production` profile.
- [ ] G2 Run the test on the current `apps/mobile/eas.json` (must pass) and do the mutation run: each rule broken once in a
  scratch copy must turn it red. Paste the output into the PR body.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: a PR that adds a production profile or a secret to `eas.json` fails the NATIVE-CI script-test step.
- States, Surfaces, Locales, Accessibility, Contract: n/a: a node test with no UI, no string and no boundary.
- Staging proof: not verified on staging: native app has no staging deploy; proven by the test and the mutation run.

<!-- lane: eas-build-workflow -->
## Lane `eas-build-workflow` (vitana-v1, governance path `.github/**`)
- [ ] B1 Add `.github/workflows/NATIVE-EAS-BUILD.yml`: `workflow_dispatch` only; inputs `profile` (`development`,
  `test-g1`) and `platform` (`ios`, `android`); `ubuntu-latest`; `working-directory: apps/mobile`; runs
  `npx eas-cli build --profile … --platform … --non-interactive` with `EXPO_TOKEN` passed through `env`; prints the
  build URL and commit SHA; never submits.
- [ ] B2 Parse the YAML; check there is no `secrets.` in any `if:`, no `production` choice, no other trigger.
- [ ] B3 After O1 (and O2 for iOS): one manual dispatch for `test-g1` + `android`; record the run link and the EAS build
  URL in `docs/validation/<VTID>/staging-tests.json` as a read-only record.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: Kiro or the owner starts a `test-g1` Android EAS build from the Actions tab and gets a build URL. iOS waits for
  O1 and O2.
- Contract: EAS CLI `build` with `--non-interactive`; profile names match `eas.json` (checked by `eas-profile-guard`).
- Staging proof: not verified on staging: native build has no staging deploy; proven by the finished EAS build for the
  dispatched commit (before O1: "not verified: waits for O1").

<!-- lane: store-owner-gate -->
## Lane `store-owner-gate` (owner, no code)
- [ ] O1–O6 The owner gives the inputs in `plan.md` "Owner-gated inputs": Expo account and `EXPO_TOKEN`; Apple access,
  bundle identifier and App Store Connect API key stored in EAS; Google Play access, package name, upload-key choice and
  service account stored in EAS; G1 provisioned; tester groups; production-profile decision (default: none).
- [ ] O7 Kiro writes one dated record per item to `docs/validation/g3/` ("done" or "open", the owner's decision, account or
  app name where not secret). The records contain no key, token, password or secret path.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: every O-item has a "done" or "open" record, so each blocked lane names the item it waits for.
- Staging proof: not verified on staging: owner records have no runtime effect; proven by a reviewer check that no secret
  value appears in `docs/validation/g3/`.

<!-- lane: eas-submit-workflow -->
## Lane `eas-submit-workflow` (vitana-v1, governance path `.github/**`; edits `apps/mobile/eas.json`)
- [ ] S1 Add a `submit` block to `apps/mobile/eas.json` with only `test-g1`: `ios.ascAppId` (from O2), `android.track:
  internal` (O3). No credential, key path, or `production` key.
- [ ] S2 Add `.github/workflows/NATIVE-EAS-SUBMIT.yml`: `workflow_dispatch` only; input `platform` (`ios`, `android`); a first
  step refuses any profile other than `test-g1` and any track other than `internal`; then
  `eas submit --profile test-g1 --platform <platform> --latest --non-interactive` with `EXPO_TOKEN` through `env`.
- [ ] S3 Check the refusal path with one dispatch using a bad input (no store call happens). After O2–O5: one real upload to the
  internal groups; record the TestFlight build and the Play internal release (version code) in
  `docs/validation/<VTID>/staging-tests.json`.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: after O1–O5, a `test-g1` build is in TestFlight for the internal group and as a Play internal release. Before
  O2–O5 the lane is merged and not run.
- Contract: EAS Submit with `--profile test-g1`, `--platform`, `--latest`, `--non-interactive`; errors fail the job.
- Staging proof: not verified on staging: the store upload is verified on the internal tracks only (the build appears in
  TestFlight; the Play release shows its version code).

<!-- lane: native-eas-runbook -->
## Lane `native-eas-runbook` (vitana-v1)
- [ ] R1 Add "EAS builds and store uploads" to `apps/mobile/README.md` after "What waits for which gate": profiles and their
  purpose; how to start a build and an upload by hand; which owner input each step needs (O1–O6); why there is no
  production profile.
- [ ] R2 Check that every link resolves (`plan.md`, `docs/validation/g3/`, both workflow files) and that the section agrees with
  `eas.json` and the two workflows.

**Acceptance**
- Change types: Tooling/docs.
- States, Surfaces, Locales, Accessibility, Contract: n/a: a markdown file with no UI, no locale string and no boundary.
- Staging proof: n/a: documentation deploys nothing; proven by the link check and the reviewer's comparison.
