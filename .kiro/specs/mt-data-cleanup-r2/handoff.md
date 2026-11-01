---
slug: mt-data-cleanup-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:30Z
---
# Handoff — mt-data-cleanup-r2
Re-plan of `mt-data-cleanup` (branch `kiro/mt-data-cleanup/plan`; PLAN-SPAR session `2efa877e` escalated at the round
cap). WS2 orphan data cleanup: orphan analysis, snapshot, remap and quarantine with the NULL-fallback writers
repointed, the memory_facts supersede-merge, the profiles.tenant_id backfill, the hot-table NOT NULL assertion, and a
new gateway lane that stops three analytics engines from writing the dead dev tenant. Plan: `plan.md`.

## Log

### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · drafted
Owner instruction 2026-11-01: "you make the decisions for me". The escalated plan is re-planned rather than approved
as escalated.
- Round-3 findings are answered in `plan.md` "Re-plan answers".
  - R3-F1: the bot-sender writers are named with file:line. Bot rows with the dead dev tenant go to quarantine for
    review, never recipient-derived, and a re-pollution check is added.
  - R3-F2: a new CODE lane, `engine-tenant-fallbacks`, covers the d46/d48/d49 gateway writers. d46 writes `…0001` on
    the authenticated path today.
- Migration slots are day-shifted to `20261102*`.
- The WS1 dependency is named as `mt-identity-r2`.
- All lanes are `executor: kiro` with reviewer `agent:vitana-lane-reviewer`. Migrations are applied only on the
  owner's approval (§7d).

The plan PR opens when PLAN-SPAR capacity allows (`collaboration.md` §8a).
