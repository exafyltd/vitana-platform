---
lane: ota-compat-gate
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: exafyltd
paths:
  - apps/mobile/src/ota/**
  - apps/mobile/src/updates/**
  - apps/mobile/tests/ota-compat.test.ts
  - apps/mobile/parity/ledger.json
updated: 2026-10-17T11:48Z
---
# OTA compatibility gate (min_native_version) — mt-native-health (repo vitana-v1)

Plan: `.kiro/specs/mt-native-health/plan.md` (ota-compat-gate) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. Independent of the other lanes (no in-spec dependency). The spec lives
in vitana-platform; the code is in vitana-v1 — open the PR in vitana-v1, branch `kiro/mt-native-health/ota-compat-gate`.

Every OTA bundle manifest declares `min_native_version` + required plugin versions; the shell reports its
version/plugins at startup and on device registration; the update client refuses an incompatible bundle and keeps the
last compatible one; native-dependent features (HealthKit, Health Connect, native push, transport flag) are gated by
runtime capability detection, not bundle version. Old-binary fixture test. OTA channel promotion itself stays
owner-gated (D19) and is out of this lane.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no live writes; local/fixture verification only.
Allowed paths only. 11 locales DE-first du-form + RTL for any user-visible string; update `parity/ledger.json`. Own
`docs/validation/<vtid>/` — not in `paths`.

PR title `VTID-xxxxx (mt-native-health/ota-compat-gate): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/ota-compat-gate`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). `min_native_version` manifest gate + runtime capability detection; incompatible bundle refused,
last compatible kept.
