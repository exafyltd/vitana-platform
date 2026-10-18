---
slug: mt-data-cleanup
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-11-01T13:20Z
---
# Handoff ΓÇö mt-data-cleanup (WS2 orphan data cleanup, quarantine, NOT NULL hardening)

Multi-tenant program spec (`docs/MULTI-TENANT-PLAN.md` v5.1, ┬º6 WS2; ┬º4.7 migration pattern; ┬º2 verified starting
state). This spec resolves the orphan / mis-tenanted rows left by the single-tenant era, quarantines dev/test and
ambiguous rows (never remapping them to Maxina), supersede-merges reassigned `memory_facts`, backfills
`profiles.tenant_id`, and makes the hot tables (`chat_messages`, `user_notifications`, `product_analytics_events`)
`tenant_id NOT NULL` via ┬º4.7 expand/contract. All lanes are DB-only; read-only counting SQL is written for Claude to
run ΓÇö Kiro never runs SQL and never writes to a live system (collaboration ┬º7a).

**Depends on mt-identity `membership-unification`** (canonical `user_tenants`) ΓÇö a cross-spec predecessor; recorded
here and in each lane body, not in lane `depends_on:` front matter (that lists only lanes of this spec).

Migration range: `20261101040000`ΓÇô`20261101045959`. DB lanes are split per ┬º4.7; each ships a forward migration, a
pre-approved rollback that restores from its `bak_*` snapshot, and read-only pre/post-check SQL under
`docs/validation/<vtid>/`.

Lanes (held at `next_actor: owner` until PLAN-SPAR allocates each VTID, then it flips to kiro):
- `orphan-analysis-and-quarantine` ΓÇö DB. Column-split analysis, `bak_*` snapshots, dev-user `ΓÇª0099` quarantine,
  bot-sent rows ΓåÆ recipient tenant, remap via canonical membership, `mt_orphan_quarantine` for 0/2+-membership owners.
  executor kiro, seat hotmail, reviewer exafy.
- `memory-facts-supersede-merge` ΓÇö DB (depends on orphan-analysis-and-quarantine). Supersede-merge reassigned facts.
  executor kiro, seat hotmail, reviewer exafy.
- `profiles-tenant-backfill` ΓÇö DB (depends on orphan-analysis-and-quarantine). Backfill `profiles.tenant_id` from
  canonical membership; column stays nullable. executor kiro, seat hotmail, reviewer exafy.
- `hot-tables-not-null-expand-contract` ΓÇö DB (depends on orphan-analysis-and-quarantine + profiles-tenant-backfill).
  ┬º4.7 NOT NULL on `chat_messages`, `user_notifications`, `product_analytics_events`. executor kiro, seat hotmail,
  reviewer jtadic.

## Log
### 2026-11-01T13:00Z ┬╖ kiro-hotmail-202610151618-b437 ┬╖ created ΓåÆ drafted
Spec shell created and pushed first (push-first, collaboration ┬º1). Premises re-verified read-only against current
platform `origin/main`: `DEV_IDENTITY.USER_ID = ΓÇª0099` / `TENANT_ID = ΓÇª0001` at
`services/gateway/src/services/orb-memory-bridge.ts:66-70`; `VITE_VITANA_BOT_USER_ID = ΓÇª0001` at `vitana-v1/.env:17`
(so `ΓÇª0001` is the bot USER id on sender/user columns and the dead dev TENANT id on `tenant_id` ΓÇö the column split in
R1/O1 depends on this); legacy NULLΓåÆ`ΓÇª0001` tenant writers live in `database/migrations/20260102_vtid_01135ΓÇª`,
`20260102_vtid_01137ΓÇª`, `20260103_vtid_01138ΓÇª`, `20260103_vtid_01139ΓÇª`, `20260103_vtid_01144ΓÇª`;
`product_analytics_events.tenant_id` nullable, service-role insert, no client RLS (`DATABASE_SCHEMA.md:2536`);
canonical `user_tenants` comes from mt-identity `membership-unification` (`.kiro/specs/mt-identity/handoff.md`), stated
as a cross-spec dependency. CROSS-SPEC-DECISIONS.md: no item names mt-data-cleanup (the lane-count merge rule was
applied ΓÇö four DB lanes, each a full ┬º4.7-split lane; none is sub-one-PR, so none merged). queue.mjs validators
(parseFrontMatter/validatePlan/validateLane) run on handoff.md + all lanes = 0 errors; tasks.md "Allowed paths" equals
the union of the four lanes' paths exactly. No source-code edits, no live-system calls. Awaiting PLAN-SPAR.

### 2026-10-17T11:09Z ┬╖ ci-plan-spar ┬╖ escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:30Z ┬╖ ci-plan-spar ┬╖ escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-11-01T13:20Z u{00B7} kiro-hotmail-202610151618-b437 u{00B7} replan u{2192} drafted
Round 1 escalated `evidence_floor_not_met`/`infra:false` (partner harness: a round needs u{2265}3 premise checks each citing a
read file). Re-verified read-only against `origin/main` and tightened two drifted citations in plan.md:
`DEV_IDENTITY` is at `orb-memory-bridge.ts:65-76` (`USER_ID` line 67 = dev user u{2026}0099`, `TENANT_ID` line 69 = dead
dev tenant u{2026}0001`) u{2014} the per-field lines premise 1's column-split depends on; and `product_analytics_events.tenant_id`
is nullable at `DATABASE_SCHEMA.md:2540` under the section header at 2536. No lane/path/dep change; markers and
change_class intact; validators still 0 errors. Re-triggering PLAN-SPAR.
