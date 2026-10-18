---
slug: mt-network
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T19:05Z
---
# Handoff — mt-network (WS3 Network layer & community/network scopes)
Planner: Kiro (seat `hotmail`), session `kiro-hotmail-202610151618-b437`, holding the `mt-network/_plan` claim. This spec implements program `docs/MULTI-TENANT-PLAN.md` §4.11 + §6 WS3: the two-scope (`community`/`network`) model for messenger, Find-a-Match and ORB recipient resolution, the network-presence opt-in, enforced message/connection sends, the legacy-message migration, and (M3, flagged) Network groups (D27, owned here). Plan: `plan.md`. Requirements/design/tasks: `requirements.md`, `design.md`, `tasks.md`.
Lanes (DB split from code per §4.7; never across repos; messenger paths → seat `exafyltd`; v1 `src/**` → `exafyltd`; gateway/services → `jtadic`; migrations/DB → `hotmail`). All held `next_actor: owner` until PLAN-SPAR allocates the VTID (then it flips to `kiro`):
- `messaging-send-db` — hotmail, platform DB — scope column, `send_message()`/`send_message_as()`, connection RPCs, client-write revokes.
- `messaging-send-gateway` — jtadic, platform — route `/send` + on-behalf sends through the RPCs, writer inventory/lint.
- `network-visibility-db` — hotmail, platform DB — `network_visible` + rule-45 trigger.
- `messenger-wiring` — exafyltd (messenger), v1 — fix inverted labels, scope wiring, one-time prompt, thread identity.
- `legacy-messages-migration-db` — hotmail, platform DB — migrate & retire legacy message/thread tables (D15).
- `matching-intent-scope-db` — hotmail, platform DB — `daily_matches`/intent scope, Vitana Index removal (D25).
- `orb-recipient-scope-gateway` — jtadic, platform — ORB recipient/search scope.
- `matching-discover-scope-v1` — exafyltd, v1 — Find-a-Match/Discover scope wiring + scoped match pool.
- `network-groups-db` — hotmail, platform DB — `chat_groups` scope + `add_group_member()` (M3, flagged).
- `network-groups-gateway` — jtadic, platform — group create/join via DEFINER (M3, flagged).
- `network-groups-v1` — exafyltd, v1 — network group UI + labels (M3, flagged).
## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Authored the mt-network spec (plan/requirements/design/tasks/handoff + 11 lane files) and pushed it as the `plan(mt-network)` PR for PLAN-SPAR. Premises re-verified against HEAD today: inverted messenger labels `Messages.tsx:153-154`; service-role `/send` writing `tenant_id/sender_id` `chat.ts:51-54,58,126-129` via `insertChatMessage` `chat-repository.ts:20-23`; `resolve_recipient_candidates(p_global:true)` `orb-tools-shared.ts:2054-2061,2278-2282,2431-2435`; no existing `send_message`/`send_message_as`/`request_connection`/`respond_connection` RPC. CROSS-SPEC "Network groups" (owned here, M3, flagged) and "Lane count" (merge rule) applied. Next: PLAN-SPAR spars the plan; on convergence the lanes get their VTIDs and flip to `next_actor: kiro`.
### 2026-10-17T11:10Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-17T15:30Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-18T19:05Z · kiro-hotmail-202610151618-b437 · replan (round 1 escalated, infra=false)
Round-1 partner error was `evidence_floor_not_met` (0 premise checks), not a plan defect — but a re-trigger needs a genuine refinement, so I re-verified premises against current `origin/main` and corrected two: (1) `chat.ts` `/send` route is at `:54` with the service-role client at `:49-52` (`getSupabase()` → `SUPABASE_SERVICE_ROLE`) and the insert fields at `:125-129` — the plan's `:58`/`:126-129` citations were drifted; fixed in Problem #2 and the `messaging-send-gateway` fix line. (2) The Fix section still named the old combined code lanes `matching-orb-scope-code` / `network-groups-code`; replaced them with the real split lanes `orb-recipient-scope-gateway` + `matching-discover-scope-v1` and `network-groups-gateway` + `network-groups-v1`, so plan.md now matches the 11 lane files, `tasks.md` and this handoff. Response: `sparring/responses-1.md`. Re-pushed to re-trigger PLAN-SPAR.
