---
slug: native-wave3-release
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-07T10:33Z
---
# Handoff — Native Wave 3: beta and release

Native app program VTID-05021 (`docs/programs/native-app/NATIVE-APP-PLAN.md`), Wave 3 row at `:199`. Plan block:
`plan.md`. Tasks: `tasks.md`. Lanes: `lanes/*.md` (11: 7 buildable now, 4 owner-gated; `appilix-retire` has no paths
until the owner opens its gate).

## State at drafting
- Drafted by Kiro on `origin/main` `1abd637af3`. No VTID is allocated. Lanes are `state: ready` with no `vtid:` field.
  CI PLAN-SPAR spars the `plan(native-wave3-release)` PR and allocates VTIDs on convergence.
- Wave 2 has not exited: the parity ledger on vitana-v1 main holds 312 `not_started` rows. Wave 1 is not complete
  (only `native-g1-wiring` `build-profiles` is merged). `prereq-exit` records both gates and holds the store and
  release lanes until they pass on machine evidence.
- Owner-held items are recorded as owner-gated lanes and are not built here: App Store Connect, Play Console, the
  Android signing key (G3), EAS cloud builds, the payment classification and the crash SDK and Firebase choice.

## What Kiro does next (no owner question needed)
1. PLAN-SPAR runs on the `plan(...)` PR. Kiro answers each round in `sparring/responses-<n>.md`.
2. On convergence, CI allocates the VTIDs and writes them into the lane files.
3. The buildable lanes with no `depends_on` start first: `client-identity-app`, `client-identity-gateway` (then `client-identity-store`),
   `crash-port`, `prereq-exit`. Then `store-declarations` and `beta-rollout-runbook` when `prereq-exit` is done.
4. Owner stops stay limited to the rows of the stop table in `.kiro/steering/vitana-owner-autonomy.md`. The owner
   gate lanes wait for the owner. The ledger and Wave 1 evidence that `prereq-exit` checks come from earlier work,
   not from this spec.

## Waiting on the owner (recorded, not built)
- G3: App Store Connect (team `62Q26QSEJW`), Play Console and the Android signing/upload key (`store-submission-owner`).
- §8 decision 4: payment classification per purchase type (`iap-decision-owner`).
- §8 decision 5: crash SDK and Firebase ownership (`crash-sdk-owner`).
- Adoption-gated: `appilix-retire` opens only after the measured adoption and crash-free thresholds hold.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → drafted
Wrote plan, tasks and 10 lane files from measured state on vitana-v1 `origin/main` `663d09a34` and vitana-platform
`origin/main` `1abd637af3`. Nothing built, no VTID allocated, no live system touched, no build pointed at a real host.
