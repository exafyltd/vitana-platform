---
slug: mt-data-cleanup
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T20:05Z
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

### 2026-11-01T13:20Z · kiro-hotmail-202610151618-b437 · replan → drafted
Session 1 escalated `evidence_floor_not_met`/`infra:false` (partner harness: a round needs ≥3 premise checks each citing a read file). Re-verified read-only and tightened two drifted citations in plan.md: `DEV_IDENTITY` at `orb-memory-bridge.ts:65-76` (`USER_ID` line 67, `TENANT_ID` line 69) and `product_analytics_events.tenant_id` nullable at `DATABASE_SCHEMA.md:2540`. No lane/path/dep change; validators 0 errors.

### 2026-11-01T13:55Z · kiro-hotmail-202610151618-b437 · answered s2 round-1 → drafted
Session 2 engaged (plan hash 8e78c46d). All 7 findings ACCEPTED and applied to plan.md; responses in `sparring/s2-responses-1.md`. Verified read-only: **R1-F1** parent line 65 (§4.11) says `chat_messages.tenant_id` is already NOT NULL — removed from Lane 4 (live `information_schema` pre-check added; its …0001 rows are Lane 1); honours the parent per the batch rule. **R1-F2** the five NULL-fallback writers (01135:357,540 / 01144:193,454 / 01137/01138/01139) still set `v_tenant_id := '…0001'` — repointed to canonical `user_tenants` in Lane 1 (raise on 0/2+). **R1-F3** fill trigger uses a direct `SECURITY DEFINER` `user_tenants` lookup, not `current_tenant_id()`. **R1-F4** fill trigger named to sort after `trg_enforce_notification_type_controls` (`DATABASE_SCHEMA.md:1085`). **R1-F5** every new DEFINER function `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`. **R1-F6** bot-id citation corrected to `services/gateway/src/lib/vitana-bot.ts:9` (parent line 28). **R1-F7** d43–d50 added to the baseline and `analyze_orphan_rows()` table list. plan.md repaired to valid UTF-8 (an earlier push had codepage-mangled it); body …15k, markers + change_class intact; queue.mjs validators 0 errors. Lane bodies unchanged this round; executor applies the lane-level detail at implementation. Re-pushed, next round starts.

### 2026-10-18T20:05Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
