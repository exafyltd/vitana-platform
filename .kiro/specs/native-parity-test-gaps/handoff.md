---
slug: native-parity-test-gaps
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-10T18:28Z
spar_refs:
  - exafyltd/vitana-v1: e31bf4627ff3c705c20f8e6b718ce4dd03353b7f
sparring_record: .kiro/specs/native-parity-test-gaps/sparring/verdict.md
vtids: [VTID-05685]
---
# Handoff — Native parity audit: close the two route-test gaps

Owner instruction: "Parity audit: check the parity ledger on main against the screen list. Find mismatches, stale rows, and missing tests. Report them. Do not change ledger status without evidence." Plan block: `plan.md`. Tasks: `tasks.md`. Lane: `lanes/route-tests.md` (1, tests only).

## State at drafting
- Audit result: ledger and screen list agree; 2 `native` rows have no route test (`/intents/mine`, `/comm/my-groups/:id`).
- No VTID is allocated. CI PLAN-SPAR spars the `plan(native-parity-test-gaps)` PR and allocates on convergence.
- Out of scope, owner-gated: 30 native rows with `last_parity_check: null`, 2 exception rows without an owner.

## What Kiro does next (no owner question needed)
1. Answer each sparring round in `sparring/responses-<n>.md`.
2. On convergence, build lane `route-tests` in vitana-v1 and open its PR. No merge without a recorded accept.

## Log
### 2026-11-10T18:10Z · kiro-exafyltd-202611072144-1c88 · created → drafted
Plan written from the read-only parity audit.

### 2026-11-10T18:24Z · ci-plan-spar · drafted → sparred
Converged; approved by policy converged-auto-v1. 0 lane(s) got a VTID and are handed to Kiro. VTID allocation failed for lane route-tests (allocate: HTTP 0 null); 1 lane(s) still lack a VTID — the next PLAN-SPAR run on this PR retries them.

### 2026-11-10T18:28Z · ci-plan-spar · sparred → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
