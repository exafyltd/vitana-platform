# Vitana Assistant — Original Plan Reconciliation

**Status**: LIVE. The agent must `git pull` before each phase.
**Owner**: Claude (autonomous multi-agent harness, fresh session).
**Date**: 2026-05-30.
**Companion to** (does NOT replace): `docs/superpowers/plans/2026-05-29-orb-recovery-autonomous-execution.md` (tactical 10-phase recovery) and `docs/superpowers/plans/2026-05-29-orb-communication-recovery.md` (V1 recovery audit).

This document re-anchors the Vitana ORB voice experience to its original architectural intent after multiple days of patch-on-patch drift. It is a **strategic** plan: it defines the endpoint the tactical recovery plan converges toward.

---

## 0. ORIGINAL MISSION (re-stated)

Vitana is a **longevity companion**. The assistant has three sustained jobs and only three:

1. **Know the user** (contextual awareness) — accumulated, structured understanding of who the user is, what they want, where they are in their journey.
2. **Teach the user** (manual delivery) — introduce Vitanaland's capabilities one by one in a paced, friendly curriculum so the user grows into the platform.
3. **Greet the user each day** (recurring touchpoint) — once per local day, summarize the journey + invite the most actionable next move.

Every spoken turn the assistant ever produces is a composition of those three. Nothing else lives at the same level. If a feature can't be expressed as one of those three or as a *consequence* of one, it does not belong on the first turn.

### The user's original mental model

> "Open the orb in the morning → Vitana greets me by name + day in journey + what matters today + offers the next concrete move. Open it again later the same day → no re-greeting; she's already minded the shop, just continue. Each day she also teaches me one new capability of the system if I haven't seen it yet. If I'm new and have no goal, she walks me into the default 90-day starter plan; once I set a goal she anchors the day around it. The journey is endless — goal by goal."

The current system fails this contract in measurable ways. This plan fixes that.

---

## 1. THE THREE PILLARS — INTENDED VS CURRENT STATE

### 1.1 Pillar I — Contextual Awareness

**Intended**: A single, deterministic context builder produces an `AssistantDecisionContext` from all available sources (user_journey, life_compass, vitana_index, calendar, autopilot, matches, messages, reminders, diary, memory, conversation_history, role, locale, time-of-day). Every provider downstream reads from this single object. Every prompt assembly reads from this single object. No source is queried twice.

**Current** (per audit of `services/gateway/src/orb/live/session/live-session-controller.ts:900–1250`):
- `firstName` fetched separately at lines 1004–1044.
- `pillarMomentum` computed inside `decideWakeBriefForSession` (line 1062).
- `buildJourneyGreetingBlock` reads `user_journey` + `life_compass` directly (line 1188–1229) — bypasses the decision context.
- `buildBootstrapContextPack` runs as a separate parallel Promise pulling memory facts + knowledge hits.
- Four independent fetches per session. No single debug view.

**Drift severity**: HIGH. The bug class "different parts of the prompt see different user state" is structurally possible today.

### 1.2 Pillar II — Teacher (manual delivery)

**Intended**: A curriculum (DB-stored, currently 25 enabled capabilities each with 4–5-sentence DE+EN intro scripts) is delivered one capability per session, paced by an awareness ledger (`user_capability_awareness`) with three states: `introduced` (7-day soft skip), `tried`/`completed`/`mastered` (terminal, never re-offer), `dismissed` (30-day cooldown). When the user accepts an intro, Teacher Mode stays active across subsequent turns until the user signals they're done.

**Current**:
- Provider selection (`feature_discovery_teacher`) is decoupled from content resolution. The provider returns a permission-asking line at priority 85; AFTER it wins, `live-session-controller.ts:1126–1170` makes a separate Supabase call to resolve Teacher Mode content. If that call fails, the provider's line still fires but turn-2+ has no instructions → LLM closes the overlay on first acceptance.
- 25 enabled capabilities; all 25 carry seeded DE+EN scripts (VTID-03168 + the 20-script seeding on 2026-05-29).
- Teacher curriculum order (`pedagogical_order`) is honored when present but most order=null entries fall to alphabetical tiebreak. The original intent was sequential foundational → community → marketplace; that ordering only exists for the first 5.
- `dragan1` has worked through everything: 5 seeded capabilities all `tried` or `completed`, 20 unseeded capabilities all `introduced` recently → eligible list empty → Teacher suppresses → voice-wake-brief 80 fallback runs.

**Drift severity**: MEDIUM. The structure is right; the content+selection coupling needs fixing; the long-tail user case (Dragan1) needs a "graduated user" Teacher track.

### 1.3 Pillar III — Daily Greeting (the recurring touchpoint)

**Intended**: Once per local-day per user, the assistant opens with a structured overview: journey day + current goal status + the day's actionable signals (calendar, autopilot, messages, reminders, diary) + ONE named concrete first move. Subsequent same-day opens skip the daily summary entirely. Reopen after >24h in user TZ → fires again.

**Current**:
- `new_day_return` provider at priority 90 (highest).
- Triggered by `user_journey.last_session_date != today_user_tz`.
- After firing, stamps `last_session_date = today` (fire-and-forget — race condition documented in the V1 recovery plan as Bug A).
- Builds payload via `gatherOverviewPayload` in `new-day-overview-payload.ts` which reuses screen-side data services (`getJourneyState`, `fetchLifeCompass`, `fetchVitanaIndexForProfiler`) — alignment with My Journey screen achieved by VTID-03172.
- Composes a structural prompt block via `buildNewDayOverviewBlock` in `new-day-overview-prompt.ts`. Contains a COVERAGE CHECKLIST, 10 composition moves, hard rules.
- Recently reverted: VTID-03184 plan_phase branching (endless-journey) was reverted on 2026-05-29 due to misdiagnosis; needs re-applying.
- **Acute production bug**: the Vertex post-login path is broken for users not on the LiveKit canary allowlist. Dragan3 is on the allowlist (works); Dragan1 was not (broken until added on 2026-05-30). Root cause of "Vertex broken post-login" is still unknown and must be diagnosed.

**Drift severity**: HIGH. Conceptually clean but operationally broken on the default production transport.

---

## 2. THE CANONICAL COMMUNICATION STATE MACHINE

This is the order Vitana must communicate in, expressed as a finite state machine. Every turn-1 output must trace to exactly one of these states.

### 2.1 Inputs

- `user_id` — null if anonymous.
- `surface` — `vitanaland` (community) | `command-hub` (developer) | `admin`.
- `last_session_date` — date in user TZ, nullable.
- `today_user_tz` — derived.
- `is_first_session` — boolean from `user_journey`.
- `life_compass.state` — `set` | `not_set`.
- `journey.plan_phase` — `default_active` (day ≤ total_days, no goal) | `default_finished_no_goal` (day > total_days, no goal) | `on_personalized_goal` (life_compass.state === `set`) | `goal_completed` (target_date in past, future Phase 2 work).
- `teacher_eligible_count` — count of capabilities eligible for the user right now.
- `wake_cadence:last_turn_at` — timestamp.
- `wake_cadence:last_greeting_at` — timestamp.

### 2.2 State table

| Session state | Spoken turn-1 producer | Why |
|---|---|---|
| Anonymous | `voice-wake-brief` (priority 80) | No identity → no continuity → light warm greeting |
| First-ever session (`is_first_session=true`) | `first-time-welcome` (NEW provider, priority 95) | One-time onboarding moment; explains Vitana herself and asks for the first goal |
| Authenticated, new local day (`last_session_date < today_user_tz`), `plan_phase=on_personalized_goal` | `new-day-return` (priority 90) | Daily catching-up moment anchored on the goal |
| Authenticated, new local day, `plan_phase=default_active` | `new-day-return` (priority 90) | Daily catching-up moment anchored on the starter plan wave |
| Authenticated, new local day, `plan_phase=default_finished_no_goal` | `new-day-return` (priority 90) | Daily catching-up moment with explicit "set your first goal" invitation |
| Authenticated, new local day, `plan_phase=goal_completed` | `goal-completion-inquiry` (NEW provider, priority 92) | "You hit your target — what's next?" handoff to set the next goal |
| Authenticated, same local day, `last_turn_at` < 15 min ago | suppress all wake providers → silent | The user just spoke; she should not re-greet |
| Authenticated, same local day, `last_turn_at` ≥ 15 min ago, Teacher has eligible capability | `feature-discovery-teacher` (priority 85) | Reopen later in the day → introduce one new capability |
| Authenticated, same local day, Teacher has no eligible capability | `voice-wake-brief` (priority 80) | Reopen later in the day with nothing new to teach → light continuity greeting |

### 2.3 Side-effects on selection

When a producer wins:

- `new-day-return` wins → after the spoken turn ends, write `user_journey.last_session_date = today_user_tz` AND `wake_cadence:last_greeting_at = now()`. Both writes are **awaited**, not fire-and-forget.
- `feature-discovery-teacher` wins → Teacher Mode in-session prompt block becomes active. On capability acceptance, advance `user_capability_awareness` to `introduced` (or `tried`/`completed` per the user's reply). Update `wake_cadence:last_greeting_at`.
- `voice-wake-brief` wins → write `wake_cadence:last_greeting_at = now()`.
- Every meaningful user turn (any provider) → write `wake_cadence:last_turn_at = now()`.

### 2.4 Subsequent turns

Once turn 1 is spoken, the system_instruction stays static for the session (the wake-brief override block is consumed once). The continuing turns are governed by:

- The persona (`voice_live` overlaid with `dev_orb` if surface=command-hub).
- The Teacher Mode block (only present if Teacher won turn 1 — then persists across turns until the user signals end via `end_teaching_session`).
- The tool catalog (search_memory, search_knowledge, etc).

---

## 3. RECONCILIATION PLAN — phases ordered by dependency

This plan composes with the tactical recovery plan at `docs/superpowers/plans/2026-05-29-orb-recovery-autonomous-execution.md`. Cross-references noted where relevant.

### Phase R0 — DIAGNOSE VERTEX POST-LOGIN (BLOCKER)

**Status**: pending.
**Priority**: CRITICAL — blocks everything because we cannot validate any code change on Vertex if Vertex is broken for non-allowlisted users.

**What we know**:
- Dragan3 was on the LiveKit canary allowlist throughout 2026-05-29 testing.
- Dragan1 was NOT on the allowlist until 2026-05-30.
- "LiveKit works, Vertex doesn't" reports actually meant "Dragan3 (allowlisted → LiveKit) works, Dragan1 (not allowlisted → Vertex) doesn't".
- Two PRs were reverted on 2026-05-29 based on this misdiagnosis.

**Tasks**:
1. Add a third test account `dragan2` or use the synthetic `a27552a3-0257-4305-8ed0-351a80fd3701` test user with deliberately minimal data (no memory_items, no life_compass, no autopilot recs). Force it NOT in the LiveKit allowlist. Open ORB authenticated. Does audio play?
2. If audio plays → the bug is data-specific (Dragan1 has accumulated something that Vertex can't handle). Bisect Dragan1's data: progressively re-add memory_items, then memory_facts, then autopilot_recommendations, etc. Find the exact source whose content breaks Vertex.
3. If audio does not play → Vertex post-login is generically broken regardless of data. Refresh `gcloud auth login`, pull `gateway` Cloud Run error logs for the last 24h filtered to `vertex.live.error` / WebSocket close / setup-failure. Read the actual Vertex API error frames.
4. Report findings + write a one-page diagnosis + fix recommendation.

**STOP-AND-ASK gate**: If finding (2) reveals the bug is in a specific row of user data, do NOT delete production data without listing the candidate rows for human review first.

**Acceptance**: a written diagnosis with file/line evidence and a specific recommended fix. No code change in this phase.

### Phase R1 — UNIFY THE AWARENESS LAYER

**Status**: pending. Depends on R0 (need Vertex working to validate).
**Files**: `services/gateway/src/orb/live/session/live-session-controller.ts`, new file `services/gateway/src/services/awareness-unified-context.ts`.

**Goal**: One function `buildUnifiedAwarenessContext(userId, surface, now)` returns a single `UnifiedAwarenessContext` object that is the *only* source of user state for all downstream prompt assembly + provider decisions. All four current fetches (firstName, pillarMomentum, journey + goal block, bootstrap pack) collapse into this one builder.

**Implementation outline**:
```ts
interface UnifiedAwarenessContext {
  identity: { user_id, tenant_id, first_name, vitana_id, active_role };
  surface: 'vitanaland' | 'command-hub' | 'admin';
  locale: { language, timezone };
  time: { now_iso, local_hour, today_user_tz, time_of_day_bucket };
  journey: { day_in_journey, total_days, plan_phase, current_wave, is_first_session, last_session_date };
  life_compass: { state: 'set'|'not_set', primary_goal, target_date, days_to_deadline, goal_progress_pct, previous_goals_count };
  vitana_index: { state: 'ok'|'not_set_up', today, tier, trend_7d, weakest_pillar, strongest_pillar, balance_label, pillars };
  pillar_momentum: { slipping_pillar, slipping_metric };
  cadence: { last_turn_at, last_greeting_at };
  signals: { calendar_today, calendar_passed, autopilot, matches_unread, messages_unread, reminders_today, diary_last_7d };
  teacher: { eligible_capabilities: CapabilityKey[], curriculum_position };
  bootstrap_pack: { memory_facts_top: 30, memory_items_top: 30, knowledge_hits, conversation_history_recent };
}
```

The builder runs all sub-fetches in `Promise.all`. Per-source failures degrade fields to null (best-effort design). Returns the unified object in <500ms p95.

Every continuation provider takes `UnifiedAwarenessContext` as its only input (no provider does its own DB fetch). Every prompt assembler reads from it.

**Acceptance**:
- One file, one function, one debug log line per session of `[awareness] built in Nms` with chars consumed.
- All four legacy fetch sites in `live-session-controller.ts` removed.
- Characterization tests prove the same instruction body emerges from the new path.

### Phase R2 — DELETE THE LEGACY GREETING-POLICY DEAD CODE

**Status**: pending. Depends on R1.
**Files**: `services/gateway/src/orb/live/instruction/live-system-instruction.ts:413-528`.

**Goal**: Remove the legacy `## GREETING POLICY` block that is unreachable when a continuation provider returns a candidate. Move its 8-bucket × 8-language fallback content into the `voice-wake-brief` provider as the priority-80 producer.

**Acceptance**:
- Lines 413-528 gone.
- `voice-wake-brief.ts` now owns the temporal fallback pools.
- No instruction-body diff on the characterization snapshots.

### Phase R3 — ATOMIC TEACHER SELECTION + CONTENT FETCH

**Status**: pending. Depends on R1.
**Files**: `services/gateway/src/services/assistant-continuation/providers/teacher/feature-discovery-teacher.ts`, `services/gateway/src/orb/teacher/teacher-content-resolver.ts`.

**Goal**: When the Teacher provider runs, it returns BOTH the greeting line AND the Teacher Mode content as a single atomic candidate. No separate post-win fetch. If content resolution fails, the provider returns `status: 'errored'` and the ranker falls through to the next provider — Teacher does NOT fire with an empty Mode block.

**Implementation outline**:
```ts
// Inside teacher provider produce():
const teacherContent = await resolveTeacherModeContent({...});
if (!teacherContent || !teacherContent.active_capability_key) {
  return { providerKey, status: 'errored', reason: 'teacher_content_resolution_failed' };
}
const candidate: AssistantContinuation = {
  ...
  teacherMode: teacherContent,  // bundled with the candidate
};
return { providerKey, status: 'returned', candidate };
```

`live-session-controller.ts` consumes `candidate.teacherMode` directly — no separate fetch.

**Acceptance**:
- No path where Teacher's permission line fires with `teacherModeContent = null`.
- New test: simulate `resolveTeacherModeContent` throwing → Teacher provider returns errored, voice-wake-brief 80 fires instead.

### Phase R4 — GRADUATED-USER TEACHER TRACK

**Status**: pending. Depends on R3.
**Files**: `services/gateway/src/services/assistant-continuation/providers/teacher/feature-discovery-teacher.ts`, `system_capabilities` DB seeds.

**Goal**: When a user has exhausted the linear curriculum (Dragan1's case: all 25 enabled capabilities introduced/tried/completed within their cooldown windows), the Teacher must NOT just suppress. It should re-engage with one of:
- **Refresh** — re-introduce a `tried` capability with deepening framing (next-level use cases) IF the user hasn't used it recently per usage events.
- **Curate** — surface a personal recommendation from Autopilot's `top` queue as a Teacher-style intro.
- **Pause gracefully** — if neither, say `"You've explored most of what Vitana offers. I'll surface new things as they ship. Want me to summarize what you've learned this month?"` once, then silent.

The DB needs a `teacher_capability_refresh_schedule` table (or jsonb on existing rows) to track "next refresh ok at" per (user_id, capability_key). 90-day default.

**Acceptance**: Dragan1 opens orb on day N+1 — Teacher fires with a refresh of `life_compass` (his current goal-anchored capability) framed as "let's revisit your North Star".

### Phase R5 — RE-APPLY THE TWO MISDIAGNOSIS REVERTS

**Status**: pending. Depends on R0 (need to know what actually broke before re-applying anything).
**Cross-reference**: `docs/superpowers/plans/2026-05-29-orb-recovery-autonomous-execution.md` Phase Re-Apply.

**Goal**: Cherry-pick the original commits for VTID-03184 (plan_phase branching, PR #2390) and BOOTSTRAP-i18n-llm-locale (PR #2392) onto fresh branches. Both were reverted on 2026-05-29 based on the misdiagnosis that Vertex was broken because of memory size; the real cause is the Vertex post-login bug (R0). Once R0 is fixed, these can come back safely.

**Acceptance**: both re-applied, deployed, dragan3 + dragan1 + the new synthetic test account all hear audio on Vertex.

### Phase R6 — FIRST-TIME-WELCOME PROVIDER (NEW)

**Status**: pending. Depends on R1.
**Goal**: Add a new continuation provider `first-time-welcome` at priority 95 that fires once per user, when `user_journey.is_first_session = true`. Its one-time output: introduce Vitana herself ("I'm Vitana, your longevity companion. Together we'll set your first goal and walk through the system..."), explain the 90-day default plan, ask the user for their first goal. After firing, flips `is_first_session = false`.

**Acceptance**: Synthetic brand-new user opens orb for the first time → hears the dedicated welcome, not the standard new-day greeting.

### Phase R7 — GOAL-COMPLETION-INQUIRY PROVIDER (NEW)

**Status**: pending. Depends on R1.
**Goal**: Add `goal-completion-inquiry` at priority 92. Fires when the active `life_compass.target_date` is in the past OR an Autopilot rule signals goal-met. One-time per goal. Speaks: "You hit your target. That's huge. Want to set the next one together, or take a moment first?" Routes through the existing Life Compass setup flow on confirmation. Old goal moves to `is_active=false` history; new goal becomes active.

**Acceptance**: Force-set a life_compass row with `target_date` in the past for the synthetic user → provider fires with celebration + invitation.

### Phase R8 — CROSS-PROVIDER PARITY ENFORCEMENT

**Status**: pending. Depends on R1-R7 shipped.
**Cross-reference**: existing recovery plan Phase ORB-1, ORB-2+3.
**Goal**: Every wake-decision and every prompt-assembly path must work identically on Vertex AND LiveKit. The LiveKit python agent (`services/agents/orb-agent/session.py`) must consume the same `UnifiedAwarenessContext`, fire the same continuation provider, and render the same first turn. The widely-misused LiveKit canary allowlist that masked the Vertex bug for two days is a symptom of missing parity verification.

**Acceptance**: Synthetic flow runs against both providers in CI. Both produce structurally-equivalent first turns for the same user state.

### Phase R9 — ACCEPTANCE CONTRACT + REGRESSION GATE

**Status**: pending. Depends on R1-R8 shipped.

The system is "back on track" when these test cases all pass automatically on every PR:

1. **Anonymous open** → voice-wake-brief plays. <2 sec to first audio.
2. **Brand-new authenticated user, never opened before** → first-time-welcome plays. Includes self-introduction + first-goal invitation.
3. **Returning user, new local day, no goal yet, day ≤ 90** → new-day-return plays as `default_active`. Names wave phase.
4. **Returning user, new local day, no goal, day > 90** → new-day-return plays as `default_finished_no_goal`. Names the goal-setting invitation.
5. **Returning user, new local day, active goal** → new-day-return plays as `on_personalized_goal`. Names the goal verbatim + day count with Vitana.
6. **Returning user, new local day, goal target_date in past** → goal-completion-inquiry plays. Celebrates + invites next goal.
7. **Returning user, same local day, <15 min since last turn** → silent (no wake provider fires).
8. **Returning user, same local day, ≥15 min since last turn, Teacher has eligible capability** → feature-discovery-teacher plays with 4-5 sentence intro.
9. **Returning user, same local day, Teacher has nothing eligible (Dragan1 case)** → graduated-user Teacher refresh fires per R4 OR voice-wake-brief plays a gentle continuity line.
10. Each of (3-9) runs on BOTH Vertex AND LiveKit and produces structurally-equivalent output.

---

## 4. WHAT TO BUILD vs WHAT TO DELETE — concrete diff summary

**BUILD**:
- `services/gateway/src/services/awareness-unified-context.ts` (new — Phase R1)
- `services/gateway/src/services/assistant-continuation/providers/first-time-welcome/` (new — Phase R6)
- `services/gateway/src/services/assistant-continuation/providers/goal-completion-inquiry/` (new — Phase R7)
- `system_capabilities` schema column or sidecar table for refresh schedule (Phase R4)
- Synthetic test account fixture (Phase R0)

**DELETE**:
- `services/gateway/src/orb/live/instruction/live-system-instruction.ts:413-528` legacy greeting-policy block (Phase R2)
- The four separate fetch call sites in `live-session-controller.ts` for firstName + pillarMomentum + journeyGreetingBlock + bootstrap (replaced by R1's unified context)
- The post-provider-win Teacher content resolution (collapsed into provider in R3)

**RESTORE** (from misdiagnosis reverts):
- VTID-03184 plan_phase branching (PR #2390, sha 6f37bcdd) — Phase R5
- BOOTSTRAP-i18n-llm-locale (PR #2392, sha 8e7570e3) — Phase R5

**KEEP AS-IS**:
- VTID-03185 audio queue closure fix (legitimate cleanup bug)
- vitana-v1 PRs #594 + #596 (cache-bust + iOS unlock)
- Teacher 25 seeded scripts (the content is good, only the loading + selection coupling changes)

---

## 5. SEQUENCING

```
R0 (diagnose Vertex) ──┐
                       ├──> R1 (unified awareness) ──> R2 (delete dead code)
R5 (re-apply reverts) ─┘                            └──> R3 (atomic Teacher) ──> R4 (graduated track)
                                                    └──> R6 (first-time-welcome)
                                                    └──> R7 (goal-completion-inquiry)
                                                              │
                                                              v
                                                          R8 (parity)
                                                              │
                                                              v
                                                          R9 (acceptance gate)
```

R0 is the strict blocker. R5 can run parallel to R1 once R0 is closed. R2-R4 and R6-R7 run parallel after R1. R8 + R9 are sequential at the end.

---

## 6. RELATIONSHIP TO OTHER PLANS

| Plan | Scope | Relationship |
|---|---|---|
| `2026-05-29-orb-communication-recovery.md` | V1 audit + recovery (audio queue, auth drift, close-clears-state, cadence, autopilot CTA) | Operates at a lower layer (transport, widget, session-state). This plan operates at the architectural layer above it. Both are needed; they don't conflict. |
| `2026-05-29-orb-recovery-autonomous-execution.md` | 10-phase tactical recovery (Memory + Recovery streams) | Phase Re-Apply, A, D in the Memory stream → still valid. Phases 0.1, 1, 2+3, 4, 5, 6 in the Recovery stream → still valid. THIS plan's Phase R0 should run BEFORE that plan's Phase Re-Apply (because R0 supersedes the misdiagnosis premise). |
| This plan | Architectural reconciliation of original 3-pillar intent | Strategic endpoint. The tactical plans converge here. |

The autonomous agent should:
1. Run this plan's R0 first (diagnosis).
2. Once R0 returns its written diagnosis, decide which of the three plans owns the resulting fix.
3. Continue working all three plans interleaved based on dependency.

---

## 7. STOP-AND-ASK GATES (this plan only — recovery plans have their own)

1. **R0 finding requires data deletion** — list candidate rows + ask before deletion.
2. **R4 graduated-user track involves new product behavior** — surface the design to the human before implementation: which refresh strategy (deepening / Autopilot curation / silence) is the default?
3. **R6 first-time-welcome content** — the actual welcome script is a product decision. Open a content PR with a draft + ask before merging.
4. **R7 goal-completion detection logic** — does "target_date in past" alone count, or does Autopilot need to confirm metric closure first? Product call.

---

## 8. FRESH-CONVERSATION PASTE PROMPT

Use this in a new Claude.ai web session (Opus recommended, Workflows enabled). The agent re-fetches the plan on every phase start so any updates land naturally.

```
You are taking over autonomous execution of the Vitana Assistant original-plan reconciliation. The plan re-anchors the ORB voice experience to its three-pillar intent (contextual awareness, Teacher, daily greeting) after multiple days of patch-on-patch drift.

THE PLAN IS THE SINGLE SOURCE OF TRUTH. Fetch it before starting and re-fetch before each phase:

  curl -sS https://raw.githubusercontent.com/exafyltd/vitana-platform/main/docs/superpowers/plans/2026-05-30-vitana-assistant-original-plan-reconciliation.md

There are TWO companion plans you must also know about:
  curl -sS https://raw.githubusercontent.com/exafyltd/vitana-platform/main/docs/superpowers/plans/2026-05-29-orb-recovery-autonomous-execution.md
  curl -sS https://raw.githubusercontent.com/exafyltd/vitana-platform/main/docs/superpowers/plans/2026-05-29-orb-communication-recovery.md

Execution order:
  1. Read all three plans IN FULL before any action.
  2. Start with this plan's Phase R0 (diagnose Vertex post-login). It is a strict blocker — no other phase can be validated until R0 returns a written diagnosis.
  3. Once R0 is closed, work the tactical plans (`2026-05-29-orb-recovery-autonomous-execution.md`) and this plan's R1-R9 in parallel where dependencies allow.

Sandbox rules (apply to all phases):
  - Define "code-complete" as: branch + draft PR + npm run build green + jest green + plan file updated with status.
  - Out-of-scope (log to docs/superpowers/plans/2026-05-29-pending-human-actions.md and move on): PR merge, EXEC-DEPLOY, prod /alive, real-account browser tests, Supabase prod writes (write migrations as files; do not run them), vitana-v1 edits (write as docs/patches/vitana-v1/<phase>.md), services/agents/orb-agent/session.py edits (write as docs/patches/orb-agent/<phase>.py with a docstring header).
  - Every gateway commit needs VTID/BOOTSTRAP marker; commits touching command-hub frontend ALSO need DEV-COMHU in PR title or branch name.
  - Every PR description states "Vertex parity ✓ / LiveKit parity ✓" with file-level evidence.

Hard rules (never violate):
  - Greeting/Teacher/journey work is community-only. Verify on vitanaland.com or Appilix, NEVER Command Hub.
  - Don't revert PRs at first suspicion. Diagnose with logs + DB introspection first. The 2026-05-29 incident reverted two PRs that were both wrong direction; root cause was a LiveKit canary allowlist asymmetry that hid the real Vertex bug from view.
  - STOP-AND-ASK at the gates listed in section 7. Otherwise: silent, continuous, autonomous.

Test accounts (use all three):
  - dragan3 (LiveKit allowlist, clean account): c5a4daf9-190a-4a9e-9638-d6b32f85244a
  - dragan1 (LiveKit allowlist as of 2026-05-30, recently pruned): 0adc6ff6-acb0-4dca-99d0-295211a40e3e
  - Create a fresh synthetic account for R0 — NO data accumulation, NOT on the LiveKit allowlist, to isolate the Vertex post-login bug.

Begin by reading the plan in full. Then start Phase R0. Update the plan file's state-machine table (this plan's section 3) and the existing autonomous-execution plan's state-machine table (section 3) as you progress. Report back only when (a) R0 returns its written diagnosis, (b) every phase R1-R9 reaches code-complete, (c) you hit a STOP-AND-ASK gate, or (d) more than 2 PRs fail CI without explanation.

Otherwise: silent, continuous, autonomous. Begin.
```

End of plan.

---

## 9. EXECUTION LOG (autonomous takeover)

### 2026-05-31 — Audit complete + PR-1 (observability) code-complete
- **Audit**: written to `docs/superpowers/plans/2026-05-31-orb-communication-audit.md` (sections A–G with file:line evidence). Confirmed: context wiring is SCATTERED (no unified awareness object); Teacher selection/content is SPLIT (permission line fires without content on resolver failure); Vertex/LiveKit share the decider but diverge on delivery, with a Vertex-only missing accept/dismiss telemetry gap masked by the LiveKit canary allowlist; the third companion plan doc does not exist on main.
- **PR-1 (VTID-03210)** — turn-1 wake-decision observability, ZERO behavior change. New `orb/live/instruction/wake-decision-snapshot.ts` emits one structured `[wake-decision]` JSON line per session, identically on Vertex (`live-session-controller.ts`) and LiveKit (`orb-livekit.ts`): winner + provider key, per-provider suppress reasons, `turn1_collision` (≥2 turn-1 blocks co-present), firstName source, transport. This is recommendation G.1 — the smallest change that makes the turn-1 state machine observable and disambiguates R0 (allowlist-masking vs prompt-collision) from production logs. 11 unit tests + 232 touched-area orb tests green; `tsc` clean. Out-of-sandbox items logged in `2026-05-29-pending-human-actions.md`.
- **Branch base decision**: all recovery work branches off `origin/main` (not the diverged `ops/autopilot-diagnose`).
- **R0 status**: deferred — the observability line is the safe precursor; live R0 diagnosis (prod log pull / test accounts) runs after PR-1 ships so the logs exist to read.