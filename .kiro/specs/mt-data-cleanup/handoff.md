---
slug: mt-data-cleanup
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-17T15:30Z
---
# Handoff — mt-data-cleanup (WS2 orphan data cleanup, quarantine, NOT NULL hardening)

Multi-tenant program spec (`docs/MULTI-TENANT-PLAN.md` v5.1, §6 WS2; §4.7 migration pattern; §2 verified starting
state). This spec resolves the orphan / mis-tenanted rows left by the single-tenant era, quarantines dev/test and
ambiguous rows (never remapping them to Maxina), supersede-merges reassigned `memory_facts`, backfills
`profiles.tenant_id`, and makes the hot tables (`chat_messages`, `user_notifications`, `product_analytics_events`)
`tenant_id NOT NULL` via §4.7 expand/contract. All lanes are DB-only; read-only counting SQL is written for Claude to
run — Kiro never runs SQL and never writes to a live system (collaboration §7a).

**Depends on mt-identity `membership-unification`** (canonical `user_tenants`) — a cross-spec predecessor; recorded
here and in each lane body, not in lane `depends_on:` front matter (that lists only lanes of this spec).

Migration range: `20261101040000`–`20261101045959`. DB lanes are split per §4.7; each ships a forward migration, a
pre-approved rollback that restores from its `bak_*` snapshot, and read-only pre/post-check SQL under
`docs/validation/<vtid>/`.

Lanes (held at `next_actor: owner` until PLAN-SPAR allocates each VTID, then it flips to kiro):
- `orphan-analysis-and-quarantine` — DB. Column-split analysis, `bak_*` snapshots, dev-user `…0099` quarantine,
  bot-sent rows → recipient tenant, remap via canonical membership, `mt_orphan_quarantine` for 0/2+-membership owners.
  executor kiro, seat hotmail, reviewer exafy.
- `memory-facts-supersede-merge` — DB (depends on orphan-analysis-and-quarantine). Supersede-merge reassigned facts.
  executor kiro, seat hotmail, reviewer exafy.
- `profiles-tenant-backfill` — DB (depends on orphan-analysis-and-quarantine). Backfill `profiles.tenant_id` from
  canonical membership; column stays nullable. executor kiro, seat hotmail, reviewer exafy.
- `hot-tables-not-null-expand-contract` — DB (depends on orphan-analysis-and-quarantine + profiles-tenant-backfill).
  §4.7 NOT NULL on `chat_messages`, `user_notifications`, `product_analytics_events`. executor kiro, seat hotmail,
  reviewer jtadic.

## Log
### 2026-11-01T13:00Z · kiro-hotmail-202610151618-b437 · created → drafted
Spec shell created and pushed first (push-first, collaboration §1). Premises re-verified read-only against current
platform `origin/main`: `DEV_IDENTITY.USER_ID = …0099` / `TENANT_ID = …0001` at
`services/gateway/src/services/orb-memory-bridge.ts:66-70`; `VITE_VITANA_BOT_USER_ID = …0001` at `vitana-v1/.env:17`
(so `…0001` is the bot USER id on sender/user columns and the dead dev TENANT id on `tenant_id` — the column split in
R1/O1 depends on this); legacy NULL→`…0001` tenant writers live in `database/migrations/20260102_vtid_01135…`,
`20260102_vtid_01137…`, `20260103_vtid_01138…`, `20260103_vtid_01139…`, `20260103_vtid_01144…`;
`product_analytics_events.tenant_id` nullable, service-role insert, no client RLS (`DATABASE_SCHEMA.md:2536`);
canonical `user_tenants` comes from mt-identity `membership-unification` (`.kiro/specs/mt-identity/handoff.md`), stated
as a cross-spec dependency. CROSS-SPEC-DECISIONS.md: no item names mt-data-cleanup (the lane-count merge rule was
applied — four DB lanes, each a full §4.7-split lane; none is sub-one-PR, so none merged). queue.mjs validators
(parseFrontMatter/validatePlan/validateLane) run on handoff.md + all lanes = 0 errors; tasks.md "Allowed paths" equals
the union of the four lanes' paths exactly. No source-code edits, no live-system calls. Awaiting PLAN-SPAR.

### 2026-10-17T11:09Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:30Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
