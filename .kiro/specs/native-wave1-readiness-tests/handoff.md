---
slug: native-wave1-readiness-tests
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-10T17:08Z
sparring_record: .kiro/specs/native-wave1-readiness-tests/sparring/verdict.md
vtids: [VTID-05681, VTID-05682, VTID-05683, VTID-05684]
---
# Handoff — Native Wave 1 readiness tests (no G1)

Native app program VTID-05021 (`docs/programs/native-app/NATIVE-APP-PLAN.md`), Wave 1 row at `:196`. Plan block: `plan.md`.
Tasks: `tasks.md`. Lanes: `lanes/*.md` (4: `auth`, `roles`, `push`, `deeplinks-i18n`, all vitana-v1, all buildable now, none owner-gated).

## State at drafting
- Drafted by one Kiro session. No VTID is allocated; lanes are `state: ready` with no `vtid:`. CI PLAN-SPAR spars the
  `plan(native-wave1-readiness-tests)` PR and allocates VTIDs on convergence.
- Pinned: vitana-v1 origin/main e31bf4627ff3c705c20f8e6b718ce4dd03353b7f.

## What Kiro does next (no owner question needed)
1. PLAN-SPAR runs; Kiro answers each round in `sparring/responses-<n>.md`.
2. On convergence CI writes the VTIDs; the four lanes start at once (no `depends_on`).
3. Owner-gated and out of scope: G1 (isolated test backend), G2, G3, any source change. These tests do not prove the Wave 1 exit.

## Log
###  · kiro-exafyltd-202611072144-1c88 · created → drafted
Plan drafted from the measured state at the pinned SHAs.

### 2026-11-10T17:08Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 4 lane(s) got a VTID and are handed to Kiro.
