# Community Autopilot: current state, unified design, and brief for the next session

**VTID-04461** · 2026-09-24 · analysis and plan only, no code change

This document plans the member-facing Autopilot, which is almost completely broken today. It is written so a fresh Claude Code session can pick it up.

- **Sections 1–3** describe what exists, measured against the live data and the code.
- **Section 4** is the target design.
- **Section 5** is the build order.
- **Section 7** is the brief to paste into the new session.

It builds on `docs/ORCHESTRATOR-REDESIGN-PLAN.md`, which already reserves phase **P5, "Community autopilot on the orchestrator"**. It does not create a second control plane. The principal resolver, policy engine, run ledger and dispatcher from P1–P4 already exist in `services/gateway/src/services/orchestrator/`, and this plan uses them.

---

## 1. The measurement in one table

Read-only queries against the Supabase project on 2026-09-24:

| Fact | Value |
|---|---|
| Community recommendations created (`source_type='community'`) | 7,906, for 228 distinct users |
| Rejected or expired | 7,334 (93 %) |
| Activated, all time | 293 |
| Activated in the last 30 days | **0** (last activation 2026-08-09 20:50 UTC) |
| Still `new` | 276 (144 community + 132 health domain) |
| What the generator produces | The same ~8 templates for every user, every day at 07:00 UTC: `weakness_stress/sleep/movement/hydration/nutrition`, `start_streak`, `invite_friend`, `engage_health`, plus one-time `onboarding_*` |
| `role_scope` on every row, dev and community alike | `any`. The column exists but nothing ever sets it. |
| Calendar events created by activation (`source_type='autopilot'`) | 226, all `status='confirmed'` |
| …of which started (`activated_at`) or completed | **0 / 0** |
| Last `automation_runs` row (AP engine) | **2026-08-15 19:00 UTC** |
| `autopilot_actions`, `autopilot_action_templates`, `automation_rules`, `automation_executions`, `tenant_autopilot_runs`, `autopilot_feedback` | 0 rows each (never used) |

Read together:

- **Suggestions are generated but not wanted.** They are generic, repeated daily, and the same for everyone.
- **When a member did say yes, nothing was executed.** Activation booked a calendar slot, and the slot was never acted on.
- **The automation engine that should act for members has not run in 40 days.**

---

## 2. What exists today

### 2.1 Three separate things are all called "community autopilot"

| # | Component | Where | What it really is |
|---|---|---|---|
| A | **Recommendation queue** | `routes/autopilot-recommendations.ts`, `services/recommendation-engine/*`, table `autopilot_recommendations` | The member-facing to-do suggestions: popup, `/autopilot` dashboard, ORB offers. The generator runs at 07:00 UTC in-process (`recommendation-engine/scheduler.ts:201`), plus auto-refill on read/activate/reject. |
| B | **AP automation engine** | `services/automation-registry.ts` (147 entries, AP-0101…AP-16xx), `services/automation-executor.ts`, `services/automation-handlers/*`, `routes/automations.ts`, table `automation_runs` | Background jobs that act *on behalf of* members: matchmaking, group nudges, onboarding, wallet, health, sharing. They are tenant-scoped and were triggered by cron, heartbeat and events. |
| C | **Recommendation inbox** | `routes/recommendation-inbox.ts`, tables `recommendations` / `recommendation_interactions` | A third, older suggestion list with its own accept/dismiss/snooze RPCs. |

A and C overlap: both are "things Vitana suggests to a member". B produces outcomes, but members cannot see them, cannot confirm them, and cannot tell where they came from.

### 2.2 Recommendation queue (A): gaps

- Activation (`activateCommunityAutopilotRecommendation`, `autopilot-recommendations.ts:1142`):
  - sets `status='activated'`;
  - upserts a `calendar_events` row (`source_ref_type='autopilot_recommendation'`);
  - sends a notification.
  - **It carries no executable action.** A recommendation is a title, a summary and a domain. There is nothing to "do", so "do it" can only mean "put it in the calendar".
- The ownership check at `:1171` (`rec.user_id && userId && rec.user_id !== userId`) passes when `rec.user_id` is null. **This is an ownership bypass and is fixed first (CA-0).**
- The role is taken from `?role=` or `X-Vitana-Active-Role`, and the frontend hard-codes `community` (`vitana-v1/src/hooks/use-autopilot.ts:92`). The server does not resolve the role itself.
- The frontend has no snooze control, although `POST /:id/snooze` exists and snooze works by voice.

### 2.3 AP engine (B): gaps

- **No working trigger in any environment:**
  - The GCP scheduler is dead.
  - `scripts/aws/setup-eventbridge-cron-migration.sh` defines the 19 AP jobs, but `--apply` was never run (the session IAM user was denied; see VTID-04226).
  - The in-process heartbeat and every event dispatch need `DEFAULT_TENANT_ID`, which is set on staging only.
- **Coverage holes:**
  - 16 IMPLEMENTED cron automations have no scheduler entry anywhere.
  - About 39 of 47 registry event topics have no dispatcher.
  - About 15 handlers are stubs or permanent no-ops, for example AP-0107/0108/0109, 0301, 0302, 0601, 0603, 0613, 0701, 1001, 1002, 1103.
  - Handlers AP-0612, 0710 and 0711 query tables that were never deployed.
- `GET /api/v1/automations/runs` and `/runs/active` always return 400 in prod: no auth identity and no `DEFAULT_TENANT_ID`. The wallet and sharing routes there always return 401.
- **Shadow mode is only partly verifiable.** In shadow mode (VTID-04349), handlers in `SHADOW_UNSAFE_HANDLERS` are skipped *before* `createRun`, so the skip leaves no `automation_runs` row. 9 of the 19 scheduled jobs are in that list.
- The notification throttle is in-memory per task and reads `autopilot_prompt_prefs`, a table that was never deployed.

### 2.4 ORB voice: the part that works best, still with gaps

These already work:

- **Tools a member can use today:**
  - `get_autopilot_recommendations` remembers which ids it read out.
  - `activate_autopilot_recommendations` uses the full activation path.
  - `activate_recommendation` covers a single offer.
  - `snooze_recommendation` and `explain_recommendation` are single-step. `dismiss_recommendation` is two-step (`awaiting_confirmation` → `confirm=true`).
- **Offers at session start:** community sessions get `buildAutopilotOfferBlock` (`live-session-controller.ts:1082`).
- **Continuation offer:** `…/next-action/sources/autopilot-recommendation.ts` stores a `pending_cta` with a 5-minute expiry (`wake-brief-wiring.ts:783`).

Gaps:

1. **"Okay, do it" depends only on the model.** The one deterministic yes-handler (`assistant-continuation/acceptance-gate.ts:136`, behind `NAV_CONTINUATION_BIND`) acts only on `navigate_to_screen`. It also deletes the stored offer when it reads it (`:147`), so with the flag on, a "yes" to an Autopilot offer can lose the id before the model calls the tool.
2. `activate_recommendation` only flips the status. It creates no calendar entry and sends no notification, unlike the other two activation paths. It also skips the `source_type='community'` check.
3. The list and activate voice tools exist only in `routes/orb-live.ts`, not in the shared registry `orb-tools-shared.ts`. The LiveKit / `/api/v1/orb/tool` path cannot use them.

### 2.5 Calendar: linked, but it never executes anything

- `calendar_events` already has:
  - `source_type='autopilot'`;
  - `source_ref_id` / `source_ref_type`;
  - `role_context` (community/admin/developer/personal/professional);
  - `activated_at`, `completed_at`, `completion_status`;
  - rrule and reminders;
  - a missed-slot rescheduler (up to 3 moves).
- Completing an event over HTTP completes the linked recommendation (`calendar.ts:743` → `complete_autopilot_recommendation`).
- **Gaps:**
  - The ORB voice `complete_event` does not complete the linked recommendation.
  - Nothing detects "this autopilot slot is due now", offers it, and runs it.
  - The `calendar_upcoming` continuation source has a CTA with no `onYesTool`.
  - Reminders only notify.

### 2.6 Roles

- There are three ways the active role is resolved today:
  - ORB: `resolveEffectiveRole`.
  - AP executor: reads `user_tenants.active_role`.
  - REST: `?role=` / header.
- The orchestrator's `resolveAgentContext` (`services/orchestrator/context.ts:91`) is meant to replace all three (P0/P1). It is not yet used by the recommendation routes.
- The policy ceilings exist (`services/orchestrator/policy.ts:47`):
  - community and patient: `commit` on community and health;
  - voice channel ceiling: `draft`.
- `assistant-role-registry.ts` has per-role tool allowlists, but it only logs and changes nothing at runtime.

### 2.7 How this relates to the Dev Autopilot

The Dev Autopilot is the *mature* autopilot. It has already solved every structural problem the community side still has:

| Concern | Dev Autopilot (works) | Community Autopilot (today) |
|---|---|---|
| Suggestion | Finding (`autopilot_recommendations`, `source_type=dev_autopilot*`), deduplicated by fingerprint and seen_count | Template row per user per day, no real dedupe; 93 % rejected |
| Executable payload | Plan versions (`dev_autopilot_plan_versions`), files, tests | **None.** Title + summary only. |
| Confirmation | Auto-approve policy (scanner allowlist, risk class) or human approve with a diff preview | Popup click, or whatever the model does with "yes" |
| Execution | Typed executor (agent), jailed tools, validation | Calendar slot, never executed |
| Run record | `dev_autopilot_executions` → `agent_runs_unified` | `automation_runs` (stalled); activations have no run at all |
| Watchers / follow-through | CI/deploy/verify watchers, self-heal | None |
| Kill switch / budgets / caps | `dev_autopilot_config`, concurrency and tail caps | Per-task in-memory throttle only |
| Supervisor view | `GET /dev-autopilot/supervisor` + Command Hub | Command Hub "Registry/Growth" tabs report stale state |

**Conclusion:** the community lane does not need a second engine. It needs the same pipeline shape with different payloads: **suggestion → offer → confirmation → typed action → run record → follow-through**. The only thing that differs by role is *what the action is*. For a developer it is a code change by an agent. For a member it is a typed, user-own action, for example logging water, booking a slot, RSVPing to an event, joining a group, starting a guided session, or sending an invite.

---

## 3. Design principles

1. **One autopilot, one pipeline, lanes per role.** Every suggestion has a `role_scope`, and every run records the role it was created under. When a member switches role, they see the lineup for that role.
2. **"Do it" must execute something.** Every community suggestion carries a typed `action` spec from a closed registry. A suggestion with no action is informational only. The model is not asked to do anything with it; it is offered as a calendar slot or as information.
3. **The server confirms; the model does not.** The spoken "yes" is bound to one stored pending action on the server, with a single-use id and an expiry. The model's tool call is the trigger, and the server decides what the "yes" applies to. There is no deletion race and no id guessing.
4. **Policy, not prompt.** Tier and channel ceilings come from `orchestrator/policy.ts`:
   - Voice may **commit** only a `low`-risk, **user-own** community or health action, and only after an explicit confirmation turn. This is the voice exception already written in ORCHESTRATOR-REDESIGN-PLAN §3.2.
   - Everything else stays at draft level: it goes into the calendar or queue, and is confirmed on the web.
5. **Every execution is an `agent_run`** (`plane='community_autopilot'`), with an idempotency key, a result, and the role and channel it came from.
6. **Nothing reaches real members without a gate.**
   - Automations stay in shadow mode until they are verified on staging.
   - Push notifications need the owner's go-ahead.
   - Test and service accounts are excluded centrally (CLAUDE.md rules 43–45: `service_bot_accounts` + `notification_test_actors`).
7. **Spoken wording is intent only (NEVER-rule 41).** Offers, confirmations and "done" acknowledgements are composed by the model from an English intent. There are no quoted sentences in `.ts` files.
8. **Reuse, then delete.** Reuse the existing ORB tool handlers as action executors instead of writing new ones. Remove stubs and never-used tables rather than keeping them "for later".

---

## 4. Target architecture

```
                 ┌──────────────── SUGGEST ────────────────┐
  generators:    recommendation engine (daily, event-driven, ranked, capped)
                 AP automations that PROPOSE (instead of acting silently)
                 calendar producers (goal plans, journey, health plans)
                 dev scanners (dev lane, unchanged)
                          │  autopilot_recommendations
                          │  + role_scope (community|patient|professional|staff|admin|developer)
                          │  + action {kind, params, risk}  (NULL = informational)
                          ▼
                 ┌──────────────── OFFER ──────────────────┐
  surfaces (all read the SAME lineup = f(resolveAgentContext().platform_role)):
     popup/dashboard · ORB session-start block · ORB continuation ranker
     · calendar (due-now provider) · push (gated)
                          │  offer → orb_session_state.pending_action {offer_id, rec_id, action, expires}
                          ▼
                 ┌──────────────── CONFIRM ────────────────┐
  confirm_pending_action / web click / auto-approve (dev lane)
  orchestrator.evaluateToolCall(ctx, domain, tier, {spoken_confirm, user_own, risk})
     allow → EXECUTE · escalate → "added to your calendar / confirm in app" · deny → say why (intent)
                          ▼
                 ┌──────────────── EXECUTE ────────────────┐
  community action registry (typed kinds → existing tool handlers)
  dev executor (unchanged)
  every execution = agent_runs row (plane community_autopilot, idempotency_key = offer_id)
                          ▼
                 ┌──────────────── FOLLOW THROUGH ─────────┐
  rec → completed · calendar event → activated/completed · outcome → next suggestion ranking
  result delivered to the role that created the run (never read out in another role)
```

### 4.1 Data model changes (additive migrations, all documented in `DATABASE_SCHEMA.md`)

- **`autopilot_recommendations`:**
  - Start actually **setting `role_scope`**: the generator writes the template's role, and dev scanners write `developer`. Backfill existing `source_type='community'` rows to `community`, and dev rows to `developer`.
  - Add **`action jsonb`**: `{kind, params, risk: 'low'|'medium'|'high', requires_slot: bool}`, validated against the action registry. NULL means informational.
- **`calendar_events`:** no new column. An autopilot event already points at its recommendation (`source_ref_*`), and the action lives on the recommendation.
- **`automation_runs`:** record shadow-unsafe skips as rows (`status='skipped'`, `metadata.reason='shadow_unsafe'`).
- **Pending-action store:** reuse `orb_session_state` (key `pending_action`, replacing `pending_cta` for autopilot offers). Rows are single-use, expire after 5 minutes, and are tied to `session_id` and `user_id`.
- **Drop** (in their own later VTID, after a grep shows zero code references): `autopilot_actions`, `autopilot_action_templates`, `automation_rules`, `automation_executions`, `tenant_autopilot_runs`, `autopilot_feedback`. All are empty and unused. Retire the recommendation inbox (C), or fold it into A, after checking its frontend callers.

### 4.2 Community action registry (new, small, closed)

`services/community-autopilot/action-registry.ts`. Each entry has:

- `kind` and a params schema (zod);
- `domain` (community | health);
- `risk`;
- `user_own: true`;
- an `execute(ctx, params)` that calls an **existing** handler. Do not re-implement logic.

A first set that maps onto existing tools:

| kind | Existing handler to reuse | Risk |
|---|---|---|
| `log_water` / `log_sleep` / `log_exercise` / `log_meditation` | ORB daily-log tools | low |
| `schedule_slot` | `upsertCalendarEntryFromSource` | low |
| `set_reminder` | reminders service | low |
| `start_guided_session` | guided-journey `focusGuidedTopic` payload (navigation + wake brief) | low |
| `open_screen` | `navigate_to_screen` | low |
| `rsvp_event` | events RSVP route handler | low |
| `join_group` | community-groups join handler | medium (visible to others) |
| `send_invite` | sharing/invite handler | medium (reaches another person) |
| `set_goal` | Life Compass / goal handler | low |

- **medium** actions can never be committed by voice. They are drafted by voice and confirmed on the web.
- There is no **high** kind in the community lane.

### 4.3 The three activation paths the owner described

**(1) Voice: "okay, do it"**

1. Vitana makes an offer (session-start block, continuation, or `get_autopilot_recommendations`). The server writes a `pending_action` with a single-use `offer_id`.
2. The member says yes. The model calls **`confirm_pending_action`**, a new tool that takes no id argument; the server resolves the offer. A member can still name an item ("the second one"), which is resolved against the ids that were read out (`session.lastListedAutopilotIds`).
3. Policy check with `channel='voice'`, `spoken_confirm=true`, and the action's risk and `user_own` flag.
   - **allow** → execute → `agent_run` → the model acknowledges from an intent.
   - **escalate** → book or draft it and tell the member where to confirm.
4. Fold `activate_recommendation` and `activate_autopilot_recommendations` into one path. The three existing tools become thin aliases over the same function, so the popup, voice and calendar can no longer diverge. Register them in `orb-tools-shared.ts` so every ORB transport has them.
5. Fix `acceptance-gate.ts` so it reads without deleting, or only consumes an offer when it handles that offer itself.

**(2) Calendar: scheduled task → Vitana asks → Autopilot executes**

- A new continuation provider, `autopilot-due-now`, looks for autopilot events whose `start_time` is between 15 minutes before and 60 minutes after now, with `completion_status` null and a linked recommendation that has an `action`. It:
  - stores the offer as a `pending_action` (same store as path 1);
  - wins turn 1 when the member opens the ORB during that window.
- When the member asks about their calendar (`get_schedule`, `search_calendar`), items with an action are marked `actionable`, so Vitana can offer them in the same turn.
- The existing calendar reminder for an autopilot slot links to the ORB with the offer pre-armed (deep link → `focus`, like guided topics), not only a push text.
- After execution the calendar event is marked `activated_at` → `completed_at`, and the recommendation is marked completed. The ORB `complete_event` gets the same `completeSourceForCalendarEvent` hook the HTTP route already has.
- A missed slot keeps the existing rescheduler behaviour (up to 3 moves), then the offer expires.

**(3) Autonomous cycles: Autopilot proposes, member says yes**

- **Replace the generator's daily blast with a ranked, capped, learning lineup:**
  - at most 3 open suggestions per member per role;
  - a template the member rejected twice is suppressed for 30 days;
  - fingerprint dedupe the way the dev lane already does (`seen_count`);
  - an expiry on every row;
  - ranking uses the member's real signals (Vitana Index gaps, streaks, calendar gaps, events nearby), not a fixed list.
- **AP automations that currently act silently are split in two:**
  - *propose*: write a recommendation with an `action`, for example "3 people match your interests, want an intro?";
  - *execute*: only after confirmation.
  - Pure maintenance automations (cleanup, scoring) stay silent. They become `agent_runs` with budgets.
- Triggers move to EventBridge through the orchestrator scheduler channel (ORCHESTRATOR plan P5). The code side is a single internal `POST /api/v1/automations/dispatch` per job, already gated by `X-Gateway-Internal`. `--apply` is the owner's step.
- The first AP run goes live **in shadow mode on staging**, and every shadow skip is recorded. Real-member notifications stay off until the owner approves them.

### 4.4 Role-aware lineups (one user, several roles)

- **One resolver:** every Autopilot surface (REST list and count, ORB offer block, continuation providers, calendar provider) gets the role from `resolveAgentContext()`. The `X-Vitana-Active-Role` header becomes a hint that can only *narrow* the result, never widen it past the permitted roles. The frontend stops hard-coding `community`.
- **The lineup is a function of role:** `lineup(ctx) = recs WHERE role_scope IN rolesVisibleFrom(ctx.platform_role) AND (user_id = ctx.user_id OR role_scope IN system roles the ctx may read)`.

  | Active role | Sees |
  |---|---|
  | community / patient | Only their own community and health suggestions |
  | developer | Dev findings (the supervisor view). **Not** their personal health suggestions. |
  | admin | Tenant automation health, plus admin suggestions |
  | professional / staff | Empty until their data exists (ORCHESTRATOR §4.2) |
- **Switching role changes the lineup on the next request or turn.** The ORB re-resolves the context on the `orchestrator.context.switched` event, and the tool catalog and offer block follow the new role.
- **A run delivers to its creating role.** A result created in community mode is never spoken in a developer session. The continuation ranker may say, in one line of intent, that something is waiting in the other role.

### 4.5 Observability

- `GET /api/v1/community-autopilot/supervisor`, the admin/dev mirror of the dev supervisor, reports per tenant:
  - suggestions created, offered, confirmed and executed;
  - rejection rate per template;
  - automation last run per AP id, with shadow/live mode;
  - skips and failures.
- Command Hub Registry/Growth tabs read it instead of the stale engine state.
- OASIS topics: `community_autopilot.offer.created|confirmed|expired`, `community_autopilot.action.executed|failed`. These are state transitions, not heartbeats.

---

## 5. Build order (each item gets its own VTID and PR, merge → staging only)

| Step | Scope | Staging acceptance |
|---|---|---|
| **CA-0: Safety fixes** | Ownership bypass at `autopilot-recommendations.ts:1171` (require `rec.user_id === userId` for community); `activate_recommendation` checks `source_type`; acceptance-gate no longer deletes offers it does not handle; ORB `complete_event` completes the linked recommendation | Unit tests; a null-owner row cannot be activated by another user |
| **CA-1: One activation path + shared registry** | `activateRecommendation(ctx, id, channel)` used by the popup, all three voice tools and the calendar; list and activate tools registered in `orb-tools-shared.ts` | Popup, voice (WS and LiveKit/`/orb/tool`) and calendar produce identical rows (calendar event + run) |
| **CA-2: Role lineups** | Backfill and set `role_scope`; routes and ORB use `resolveAgentContext`; header only narrows; frontend drops the hard-coded `community` (vitana-v1 PR) | Same user, role switched: the list changes; a developer never sees personal health recs (test) |
| **CA-3: Action registry + confirm-then-execute** | `action` column + registry (§4.2); `pending_action` store; `confirm_pending_action` tool; policy `spoken_confirm` exception for low-risk, user-own actions; `agent_runs` writes (`plane=community_autopilot`) | A seeded suggestion (on a staging-only fixture user, **never** the documented test account and never a real member) executes by voice and appears in `agent_runs_unified`; a medium action escalates instead |
| **CA-4: Calendar due-now** | `autopilot-due-now` continuation provider; `actionable` flag in `get_schedule`/`search_calendar`; reminder deep link arms the offer | Unit tests for the window/expiry logic; ORB turn-1 selection test |
| **CA-5: Generator rebuild** | Cap, dedupe, suppression, expiry, signal-based ranking; recommendation inbox (C) folded in or retired | Generator unit tests; on staging the daily run no longer re-creates rejected templates |
| **CA-6: AP engine on the orchestrator** | Propose/execute split for member-facing automations; shadow skips recorded; `/automations/runs` tenant from context, not the env; stubs removed or honestly marked PLANNED; supervisor endpoint + Command Hub tabs | Staging shadow run for every scheduled AP id with a row each; supervisor shows it. The **owner** runs the EventBridge `--apply` |
| **CA-7: Cleanup** | Drop the never-used tables (§4.1), `autopilot-prompts` routes if dead, stale docs | Grep shows zero references; Migration Drift Check green |

**Critical path:** CA-0 → CA-1 → CA-3. CA-2 can run in parallel with CA-1. CA-4 needs CA-3. CA-5 and CA-6 can follow in either order.

---

## 6. Decisions only the owner can make

1. **Voice commit exception:** may a low-risk, user-own action (log water, book a slot, set a reminder, RSVP) run on a spoken "yes" alone? *Recommended: yes, as ORCHESTRATOR §3.2 already proposes; medium and high never.*
2. **The EventBridge `--apply`** for the AP jobs (session IAM cannot do it), and when any automation may notify real members (shadow until then).
3. **Fold or retire** the old recommendation inbox (`/api/v1/recommendations`).
4. **Caps:** open suggestions per member per role (proposed: 3), and pushes per member per day (proposed: 2).

---

## 7. Brief for the fresh session (paste this)

> You are continuing **Community Autopilot**. Read `docs/COMMUNITY-AUTOPILOT-PLAN.md` (VTID-04461) end to end, then `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3–§5 (you are building its phase P5). Work in `exafyltd/vitana-platform` (gateway) and `exafyltd/vitana-v1` (frontend).
>
> **Goal:** a community member's Autopilot suggestions are role-aware, carry a real executable action, and run when the member says "okay, do it". The trigger can be a voice offer, a due calendar slot, or an autonomous suggestion. Every execution is an `agent_run`.
>
> **Order:** CA-0 → CA-1 → CA-3 first, with CA-2 in parallel (plan §5). One self-allocated VTID per step (`allocate_global_vtid`, set `in_progress`/`approved`), one PR per step, with an evidence pack in `docs/validation/<VTID>/` (`acceptance.md` lines start with `AC-n` and have a `TEST:` line; `commands.log`; a non-empty `outputs/`). The PR body uses plain `KEY:` lines: `VTID:`, `VALIDATION_PROFILE: gateway_backend`, `SCOPE_ALLOWLIST:`, `ACCEPTANCE:`, `MERGE_PAYLOAD_PREVIEW:`, `OASIS_IMPACT:`.
>
> **Reuse, do not rebuild:**
> - `services/orchestrator/{context,policy,run-ledger,dispatcher}.ts`;
> - `routes/autopilot-recommendations.ts` `activateCommunityAutopilotRecommendation`;
> - `orb_session_state` pending-CTA storage (`wake-brief-wiring.ts:783`);
> - `upsertCalendarEntryFromSource`, `completeSourceForCalendarEvent`;
> - the continuation provider framework (`services/assistant-continuation/`);
> - the existing ORB tool handlers as action executors.
>
> **Hard rules:**
> - Staging only; production is the owner's PUBLISH.
> - Never test against production. Never write as the documented test account on any host; use unit tests or a staging fixture you create and remove.
> - No notifications to real members; AP automations stay `AUTOMATIONS_DELIVERY_MODE=shadow` until the owner approves.
> - Exclude `service_bot_accounts` and `notification_test_actors` from every lineup and target set.
> - No hardcoded spoken sentences: write intents in English.
> - Voice may commit only low-risk, user-own actions after an explicit confirmation; medium actions escalate to the web.
> - Claude via Bedrock only.
>
> **Known live facts (2026-09-24):**
> - 0 activations in 30 days; the 226 autopilot calendar events were never executed; `role_scope` is always `any`.
> - AP engine: last run 2026-08-15. EventBridge `--apply` is blocked by IAM (owner step).
> - Ownership bypass at `autopilot-recommendations.ts:1171`: fix it first.
> - AWS was fully down from 2026-09-23 22:37 UTC. If it still is, build and test locally (jest, `tsc --noEmit`) and report the deploy step as blocked. Do not keep reporting the outage.

---

## 8. Sources

- Live read-only queries (Supabase, 2026-09-24): `autopilot_recommendations` by source/status/role_scope/source_ref; `calendar_events` where `source_type='autopilot'`; `automation_runs` max(created_at); row counts of the unused autopilot tables.
- Code survey 2026-09-24 of the paths cited inline (gateway `services/gateway/src/**`, frontend `vitana-v1/src/**`).
- `docs/ORCHESTRATOR-REDESIGN-PLAN.md`, `docs/autopilot-automations/*`, `docs/validation/VTID-04226/`.
