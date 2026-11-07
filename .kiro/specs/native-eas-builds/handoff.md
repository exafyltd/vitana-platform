---
slug: native-eas-builds
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-07T10:33Z
---
# Handoff — EAS cloud builds and TestFlight / Play internal track

Native app programme VTID-05021 (`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md`), Wave 0 setup (EAS builds)
and Wave 3 internal distribution. Plan block: `plan.md`. Lanes: `lanes/*.md` (5 lanes, disjoint `paths`).

The plan covers EAS cloud builds for the `development` and `test-g1` profiles (iOS and Android device builds),
uploads to the TestFlight internal group and the Play internal track, and the owner-gated inputs O1–O6. It adds no
production profile. No VTID is allocated: CI PLAN-SPAR allocates after convergence.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → drafted
Holder of the `native-eas-builds/_plan` claim. Wrote `plan.md`, `handoff.md`, `tasks.md` and 5 lane files, all
`ready` (store-owner-gate `next_actor: owner`). Measured on `vitana-v1` `origin/main` `663d09a34`: `apps/mobile/eas.json`
has exactly the `development` and `test-g1` profiles, no `production`, no `submit`, no credential; NATIVE-CI runs
`scripts/native/__tests__/*.test.mjs` on ubuntu. Checked two vendor facts with the Expo docs: Expo Submit uploads
iOS builds to App Store Connect and TestFlight internal testing needs no Beta App Review; `eas submit` creates the
first Play release on the internal track, so a manual first upload is optional.
Next: CI PLAN-SPAR sparring round on the `plan(native-eas-builds)` PR. Gate for the owner: O1–O6 in `plan.md`.
No code changed, no live system touched, no build or upload run.
