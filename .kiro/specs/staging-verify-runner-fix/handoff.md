---
slug: staging-verify-runner-fix
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-22T11:14Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/staging-verify-runner-fix/sparring/verdict.md
vtids: [VTID-05333, VTID-05334]
---
# Handoff — STAGING-VERIFY: runner image, native suite commands, bundle profile
Owner, 2026-10-22 (Kiro Web): "ok, let's fix the verification first". This unblocks Gate 2 for VTID-05330 (vitana-v1
`3d144939`). Plan block: `plan.md`. Lanes: `lanes/runner.md` (vitana-platform), `lanes/manifests.md` (vitana-v1,
depends on `runner`).

## Log
### 2026-10-22T11:00Z · kiro-exafyltd-202610220818-5273 · created → drafted
Holder of the `staging-verify-runner-fix/_plan` claim. Read the failed run 39757004449, `STAGING-VERIFY.yml`,
`scripts/ci/staging-verify/{run.mjs,lib.cjs}`, the VTID-05298/05296 manifests and NATIVE-CI on main. Decision taken:
lane `runner` gets `seat: exafyltd` although `scripts/**` maps to `platform` (seat `exafy`), because the owner asked
this session to run the fix end to end and the lane is mixed (`.github/**` is not in any specific area). No VTID
allocated, no live system touched.
Next: PLAN-SPAR spars the `plan(staging-verify-runner-fix)` PR; this session answers each round.

### 2026-10-22T11:14Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.
