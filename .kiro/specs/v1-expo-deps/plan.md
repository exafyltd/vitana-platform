# Plan — v1-expo-deps (vitana-v1 apps/mobile Expo dependency check)
**Status:** drafted. **Owner/approver:** project owner. **Repo:** exafyltd/vitana-v1 (GitLab vitana/vitana-v1).

## Premises (read on vitana-v1 main bbe90b71373e76b18e3a93e22db17b6953c0a183)
- P1 `apps/mobile/package.json` pins exact versions: expo 57.0.25, expo-constants 57.0.19, expo-contacts 57.0.8, expo-crypto 57.0.3,
  expo-image-picker 57.0.20, expo-linking 57.0.11, expo-router 57.0.23, jest-expo 57.0.5. Script `deps:check` = `expo install --check`.
- P2 GitLab job `full-suite:mobile-test` (central file `v1-delivery.gitlab-ci.yml`, line ~1821) runs `npm run deps:check` on every main
  push. Pipeline 441 job 2996: "expected version: ~57.0.33" for expo, plus 7 more packages, exit 1.
- P3 GitHub NATIVE-CI runs the same step only when its `changes` job selects the mobile job, so the drift stayed hidden there.
- P4 `expo install --check` compares against the newest patch for the SDK. A new Expo patch release can turn the check red with no repo change.

## Change
Bring the eight packages to the versions `expo install --check` expects, with the lockfile regenerated, and prove it with the same
command the GitLab job runs. Out of scope: the central CI file, the GitHub workflows, and any other package.

## Open decision (for sparring)
- D1 Whether only the versions are bumped, or the check is also made reproducible. The second option would pin the check to the lockfile,
  or tell the check about accepted versions, so a future Expo patch release cannot turn main red. This plan proposes neither.

## Verification
`npm ci && npm run deps:check && npm test -- --ci && npm run typecheck` in `apps/mobile`. The GitLab `mobile-test` job is green on the
lane's MR. Not verified on staging: native packages, no web deploy path.
