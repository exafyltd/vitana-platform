---
slug: native-iap-interface
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-10T17:10Z
---
# Handoff — Native IAP interface and feature flag (no vendor)

Native app program VTID-05021 (`docs/programs/native-app/NATIVE-APP-PLAN.md`). Plan block: `plan.md`. Tasks: `tasks.md`.
Lane: `lanes/iap-interface.md` (one lane, vitana-v1).

## State at drafting
- No VTID is allocated. The lane is `state: ready` with no `vtid:` field. CI PLAN-SPAR spars the
  `plan(native-iap-interface)` PR and allocates the VTID on convergence.
- The vendor, product IDs, store setup and the payment classification stay with the owner (`iap-decision-owner` in
  `native-wave3-release-r2`). This plan builds an interface and a flag that defaults OFF, nothing else.

## What Kiro does next (no owner question needed)
1. Answer each sparring round in `sparring/responses-<n>.md`.
2. On convergence CI writes the VTID into the lane file; Kiro builds `iap-interface`.

## Log
### 2026-11-10T17:10Z · kiro-exafyltd-202611072144-1c88 · created → drafted
Plan written for the owner instruction "in-app purchase module: interface and feature flag only, no vendor chosen".
