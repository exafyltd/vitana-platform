# Vitana Assistant ORB — Communication Reconciliation Audit

**Date**: 2026-05-31.
**Basis**: `origin/main` @ `24b743dc` (read via a clean worktree, NOT a feature branch).
**Author**: Claude (autonomous takeover session).
**Companion to**: `2026-05-30-vitana-assistant-original-plan-reconciliation.md` (strategic R0–R9) and `2026-05-29-orb-recovery-autonomous-execution.md` (tactical 10-phase).

This is the audit the reconciliation takeover required BEFORE any code. It maps which turn-1 pieces are wired, unwired, duplicated, dead, or fighting each other.

## Plan-doc reality check
- ✅ `2026-05-30-vitana-assistant-original-plan-reconciliation.md` — exists.
- ✅ `2026-05-29-orb-recovery-autonomous-execution.md` — exists; **0 of 12 phases shipped** (every row `pending`, no Branch/PR/SHA).
- ❌ `2026-05-29-orb-communication-recovery.md` — **DOES NOT EXIST on main.** Both surviving docs reference it as a real companion ("V1 recovery audit"). Its "Bug A / Bug D" race claims are unsourced — do not treat as authoritative.

---

## A. First-turn state machine
One shared decider — `decideWakeBriefForSession` (`services/gateway/src/services/wake-brief-wiring.ts:246`) → `decideContinuation({surface:'orb_wake'})`, ranked by descending priority (`decide-continuation.ts:104-118`). Both transports call it: Vertex `live-session-controller.ts:1046`, LiveKit `routes/orb-livekit.ts:1574`. Eligibility/ranking identical; only delivery differs.

| Priority | Provider | File | Notes |
|---|---|---|---|
| ≤100 (clamped to source) | `contextual_next_action` | `providers/next-action/index.ts:90,216` | composes 9 sources; suppresses if best < threshold 50 |
| 90 | `new_day_return` | `providers/new-day-return.ts:64` | once per new calendar day (user TZ) |
| 85 | `feature_discovery_teacher` | `providers/teacher/feature-discovery-teacher.ts:76` | not cadence-gated |
| 80 | `voice_wake_brief` | `providers/voice-wake-brief.ts:199` | pure fallback; generic line / pillar nudge |

**Absent providers the plan calls for:** `first-time-welcome` (only a `journey-greeting.ts` prompt block, not a ranked provider — `new-day-return.ts:496-503`), `goal-completion-inquiry` (no symbol).

## B. Context wiring — VERDICT: SCATTERED. No unified awareness object.
`awareness-unified-context.ts` / `buildUnifiedAwarenessContext` does not exist. Per session, `handleLiveSessionStart` fans out into 4+ independent pipelines writing loose `(session as any).*` fields: bootstrap/brain (`live-session-controller.ts:671-712`), decision spine (`:969-983`), firstName (`:1004-1044`), wake decision (`:1046-1079`), journey-greeting w/ its own `app_users` read (`:1187-1229`).
- **Smoking gun 1:** `(session).decisionContext` set at `:983` but never read in `orb-live.ts` (grep → nothing); only `pillar_momentum` forwarded by value (`:1062`). The other 4 distilled fields are computed then dropped.
- **Smoking gun 2:** two forked `AssistantDecisionContext` types (`orb/context/types.ts:469` vs `assistant-decision-context.ts:91`); the latter's compiler is reachable only via debug route `routes/voice-journey-context.ts:73`.
- Disagreement risk: `vitana_index_scores` read limit-60 + limit-21 in same compile; firstName resolved up to 4× with different precedence; `life_compass` ~10 readers, no shared snapshot.

## C. Teacher wiring — VERDICT: SPLIT (not atomic).
- Permission line committed unconditionally: `live-session-controller.ts:1104-1121`.
- Content resolved in a SEPARATE Supabase call AFTER the win: `:1144-1158` (`resolveTeacherModeContent`). Provider `produce()` (`feature-discovery-teacher.ts:293-479`) bundles only the line + cta payload.
- Failure mode: blocks concatenated independently — `orb-live.ts:5822` appends the line ALWAYS; `:5850-5856` appends content only if resolved. On null/throw the catch (`:1164-1168`) logs and moves on → permission line fires with no turn-2 content (the documented VTID-03160 failure; comment at `:1230-1239`). No fall-through to next provider.
- Ledger: `user_capability_awareness` (7 states), sole writer `advance_capability_awareness` RPC; cooldowns 7d/30d/3-strike.
- Graduated-user track: **ABSENT** (only comment `feature-discovery-teacher.ts:316`). Suppresses → voice-wake-brief.

## D. Generic-greeting drift sources
1. `orb-live.ts:6670-6679` — legacy generic menu in `sendGreetingPromptToLiveAPI` (Vertex), reachable when no candidate + not a recognized cadence-skip. **Primary risk.**
2. `voice-wake-brief.ts:95-110` — `DEFAULT_LINES` ("Hello! How can I help today?").
3. `live-system-instruction.ts:413-528` — legacy `## GREETING POLICY` block; LiveKit omits it (`omitGreetingPolicy=true`), Vertex renders it under the override (soft conflict).
4. `greeting-pools.ts:26-107` — short-gap pools (scoped, suppressed under override).
5. `journey-greeting.ts` / `new-day-overview-prompt.ts` — forbid generic greetings but coexist with the Teacher override on new-day Vertex (VTID-03160 revert `:1230-1252`) and double-write `last_session_date`.

**Cadence:** all writes fire-and-forget; `last_session_date` has TWO un-awaited writers (`new-day-return.ts:588` + `live-session-controller.ts:1263`) → race.

## E. Vertex vs LiveKit parity — same decision, divergent delivery; 2 latent defects.
- Same ranker both sides. Vertex injects once → model speaks → natively in context. LiveKit injects TWICE (gateway system-instruction override `orb-livekit.ts:1651-1678` + Python `session.say()` `session.py:2218`).
- LiveKit `session.say(..., add_to_chat_ctx=bool(is_proactive_offer))` — generic greetings stay OUT of chat_ctx → model can deny saying it (VTID-03076 mode).
- "Yes" handling: LiveKit intercepts + POSTs `/voice/next-action/event` (`session.py:1365`); **Vertex has no intercept** — OASIS `suggested→accepted` never closed. `active-provider-resolver.ts:104-190` pins non-allowlisted users to Vertex → the gap dominates production while the canary-only LiveKit path looks complete (the allowlist-masking asymmetry).
- Parity tests: only `test/orb/routes/livekit-context-parity.test.ts`, a static source-text wire-up assertion. No behavioral first-turn parity test.

## F. Missing pieces
Unified awareness — ABSENT. Greeting-policy removal — NOT DONE. Atomic Teacher — PARTIAL (resolver exists, bundling absent). Graduated Teacher — ABSENT. First-time-welcome — ABSENT. Goal-completion — ABSENT. Parity tests — inadequate. 10-case acceptance suite — ABSENT. vitana-v1 ACT/DISMISS — separate repo (audit there). Match-journey hooks — STUBBED (`match-journey-context-provider.ts:140-144` returns `{journeyStage:'none'}`). Daily-greeting signals — wired except **"promises"** (`new-day-overview-payload.ts:197-241`). Also: `orb_session_state` table (Recovery ORB-2+3 dep) has no migration on main.

## G. Recommended minimum PR sequence
1. **PR-1 (VTID-03210) — observability only, zero behavior change.** One structured `[wake-decision]` log line per session on both transports: winner + per-provider suppress reasons, turn-1 block collision flag, firstName source, transport. Answers the R0 ambiguity (allowlist-masking vs prompt-collision) without touching spoken behavior. **← this PR.**
2. PR-2 — close Teacher atomicity (C): bundle content into the candidate; errored → fall through.
3. PR-3 — resolve Vertex turn-1 collision (D): override authoritative; suppress legacy greeting-policy on Vertex; stop the journey double-write.
4. Then R1 unified awareness, R8 behavioral parity test, R6/R7 new providers.

Each PR: one VTID, tests, Vertex+LiveKit evidence. "Done" = code tests + a real vitanaland.com ORB / LiveKit Test Bench spoken check.
