---
slug: mt-network
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T20:33Z
---
# Handoff — mt-network (WS3 Network layer & community/network scopes)
Planner: Kiro (seat `hotmail`), session `kiro-hotmail-202610151618-b437`, holding the `mt-network/_plan` claim. This spec implements program `docs/MULTI-TENANT-PLAN.md` §4.11 + §6 WS3: the two-scope (`community`/`network`) model for messenger, Find-a-Match and ORB recipient resolution, the network-presence opt-in, enforced message/connection sends, the legacy-message migration, and (M3, flagged) Network groups (D27, owned here). Plan: `plan.md`. Requirements/design/tasks: `requirements.md`, `design.md`, `tasks.md`.
Lanes (DB split from code per §4.7; never across repos; messenger paths → seat `exafyltd`; v1 `src/**` → `exafyltd`; gateway/services → `jtadic`; migrations/DB → `hotmail`). All held `next_actor: owner` until PLAN-SPAR allocates the VTID (then it flips to `kiro`):
- `messaging-send-db` — hotmail, **platform** DB — `chat_messages.scope`, `send_message()`/`send_message_as()`, `service_role_manage_chat` policy drop, client-write revoke.
- `messaging-send-gateway` — jtadic, platform — route `/send` + on-behalf sends through the RPCs, writer inventory/lint.
- `network-visibility-db` — exafyltd, **vitana-v1** DB — `network_visible`/`messaging_preference` + rule-45 trigger + `connection_requests` RPCs (both v1 tables).
- `messenger-wiring` — exafyltd (messenger), v1 — fix inverted labels, scope wiring, one-time prompt, thread identity.
- `legacy-messages-migration-db` — exafyltd, **vitana-v1** DB — migrate & retire legacy message/thread tables, all v1 (D15).
- `matching-intent-scope-db` — exafyltd, **vitana-v1** DB — `daily_matches`/intent scope, Vitana Index removal (D25).
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
Round-1 (session 875b594f) partner error was `evidence_floor_not_met` (0 premise checks), not a plan defect — but a re-trigger needs a genuine refinement, so I re-verified premises against current `origin/main` and corrected two: (1) `chat.ts` `/send` route is at `:54`, service-role client `:49-52`, insert fields `:125-129` (plan's `:58`/`:126-129` were drifted). (2) The Fix section still named the old combined code lanes `matching-orb-scope-code`/`network-groups-code`; replaced with the real split lanes `orb-recipient-scope-gateway`+`matching-discover-scope-v1` and `network-groups-gateway`+`network-groups-v1`. Response: `sparring/responses-1.md`. Re-pushed; PLAN-SPAR then produced session c7a55d62 s2-round-1 (5 findings, in_progress).
### 2026-10-18T19:40Z · kiro-hotmail-202610151618-b437 · replan (s2-round-1, session c7a55d62 — 5 findings answered)
PLAN-SPAR's partner reviewed with real evidence and found a systemic repo-placement error I verified and accepted (R1-F1/F2/F4/F5): `daily_matches`+`match_reasons`+intent matchers (`generate-daily-matches` Edge Function), `global_community_profiles`, `connection_requests`, `global_messages`/`global_message_threads`, `messages`/`message_threads` are **all vitana-v1 tables**, not platform — so three DB lanes were on the wrong repo. Reassigned `network-visibility-db`, `legacy-messages-migration-db`, `matching-intent-scope-db` to **vitana-v1** (seat `hotmail`→`exafyltd`, reviewer→`hotmail`), moved the `connection_requests` RPCs into `network-visibility-db` and dropped platform-only paths (`services/gateway/test`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json` — v1 has none; pgTAP now `supabase/tests/`, the queue row is a platform-side follow-up). R1-F3 accepted: `messaging-send-db` now DROPs the catch-all `service_role_manage_chat` policy (`20260225200000:35-36`). R1-F2 accepted-with-correction: the Edge Function exists in v1 (the partner saw only the platform pin). R1-F1: v1 `daily_matches` (not platform `matches_daily`), `match_reasons` column, unique key respected. Response: `sparring/s2-responses-1.md`. Re-pushed to re-trigger PLAN-SPAR.

### 2026-10-18T20:03Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:11Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:19Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:29Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
