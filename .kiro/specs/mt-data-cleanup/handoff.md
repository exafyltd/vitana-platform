---
slug: mt-data-cleanup
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-19T18:10Z
---
# Handoff — mt-data-cleanup (WS2 orphan data cleanup, quarantine, NOT NULL hardening)

Lanes (held at `next_actor: owner` until PLAN-SPAR allocates each VTID, then it flips to kiro):
- `orphan-analysis-and-quarantine` — DB. Column-split analysis, `bak_*` snapshots, dev-user `…0099` quarantine,
  bot-sent rows → recipient tenant, remap via canonical membership, `mt_orphan_quarantine` for 0/2+-membership owners.
  executor kiro, seat hotmail, reviewer exafy.
- `memory-facts-supersede-merge` — DB (depends on orphan-analysis-and-quarantine). Supersede-merge reassigned facts.
  executor kiro, seat hotmail, reviewer exafy.
- `profiles-tenant-backfill` — DB (depends on orphan-analysis-and-quarantine). Backfill `profiles.tenant_id` from
  canonical membership; column stays nullable. executor kiro, seat hotmail, reviewer exafy.
- `hot-tables-not-null-expand-contract` — DB (depends on orphan-analysis-and-quarantine + profiles-tenant-backfill).
  Assert-and-pin NOT NULL on `chat_messages`, `user_notifications`, `product_analytics_events` (already NOT NULL in
  DDL; no expand/contract) + `DATABASE_SCHEMA.md` fix. executor kiro, seat hotmail, reviewer jtadic.

## Log
### 2026-10-19T17:33Z · kiro-hotmail-202610151618-b437 · created → drafted
Republishes PR #4170 (closed in error) from its head commit `eae44547c09058f9bd51fdd8b4e63d316c43d81f`. plan.md,
requirements.md, design.md, tasks.md and lanes/*.md are byte-identical to that commit (valid UTF-8, LF, no BOM);
`sparring/` intentionally omitted so this branch starts a fresh sparring session. queue.mjs validators
(parseFrontMatter/validatePlan/validateLane) on handoff.md + all lanes = 0 errors. Awaiting PLAN-SPAR.
### 2026-10-19T18:10Z · kiro-hotmail-202610151618-b437 · sparring round 1 answered
R1-F1/F2 accepted: the three hot tables are already `tenant_id NOT NULL` in DDL, so lane
`hot-tables-not-null-expand-contract` is rescoped to an assertion-only migration + `DATABASE_SCHEMA.md` fix (path
added); no trigger/backfill. R1-F3 accepted with a corrected premise: 01142/01143 have no fallback, but a full grep
found `20260102200000_vtid_01127_availability_readiness_engine.sql` (5 fallbacks) — six migrations are repointed in
Lane 1 (task O8). R1-F4 accepted: precondition gate + local pgTAP call-tests + read-only `pg_get_functiondef` post-check.
