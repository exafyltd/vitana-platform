# ORB Recovery + Memory Resilience — Pending Human Actions

**One place to look.** This file aggregates every action that requires human/prod hands
(merge, deploy, DB writes, cross-repo edits, real-account smokes) for the autonomous
execution of `2026-05-29-orb-recovery-autonomous-execution.md`.

The autonomous agent runs in a sandbox that **cannot** merge PRs, run EXEC-DEPLOY,
reach prod URLs, write to Supabase, or edit the `vitana-v1` repo / `orb-agent` Python.
Each phase is delivered as a **draft PR that builds + passes jest**; the remaining
steps are listed here.

Legend: each box is a ~30-second click or a copy-paste command, not an engineering task.

---

# RELEASE RUNBOOK (read first)

Status: **integration-ready, NOT production-complete.** The remaining risk is
sequencing, deploy gates, and live-provider parity — not unwritten code. Work the three
buckets below in order. Do **not** let "click to merge" swallow a migration / patch /
live-smoke prerequisite.

## Strict merge + deploy order

Merge and let EXEC-DEPLOY finish (verify `/alive` 200) **one at a time**, in this order:

```
#2400 → #2401 → #2403 → #2408 → #2411      (Memory stream)
  then
#2431 → #2432 → #2435 → #2437 → #2438 → #2439   (Recovery stream)
```

Rationale: Recovery PRs touch the shared widget + `live-system-instruction.ts` lineage;
landing serially keeps the cache-bust + instruction contract coherent. `#2437` (audio-
ready) and `#2438`/`#2439` consume the `orb_session_state` substrate from `#2435`.

## Bucket 1 — MERGE BLOCKERS (must be true *before* the merge of that PR)

- [ ] **#2438 / #2439:** the in-progress `Gateway Service Tests` jobs are **truly green**, not just historically flaky. Confirm the latest run is `success` before merging. (Re-trigger once if it flakes; if it fails twice on real content, stop and investigate.)
- [ ] **#2408 merge blocker:** confirm the `exec_sql(query, params)` RPC exists in the target Supabase project (the voice-budget route + cron depend on it). If absent, repoint `fetchVoiceBudgetWatch` to the project's standard parameterised-SQL path *before* merge.
- [ ] **#2435 merge blocker:** apply migration `supabase/migrations/20260606000000_DEV_COMHU_0503_orb_session_state.sql` to the target Supabase project **before** merging #2435 (and therefore before #2437/#2438 which depend on the table). Creates `orb_session_state` + `orb_session_state_gc()`.
- [ ] **Phase C (#2412):** HARD founder gate. Docs-only PR may merge, but **no Phase C code branch starts** until §10 is answered. Not in the deploy sequence above.

## Bucket 2 — PROD DEPLOY TASKS (do as part of each phase's rollout, post-merge)

- [ ] After **every** merge: confirm EXEC-DEPLOY SUCCESS, then `curl /alive` → 200 JSON.
- [ ] Apply the **`vitana-v1` patches** before claiming cross-provider parity in prod:
  `ORB-0.1-speaking-watchdog.md`, `ORB-1-auth-contract.md`, `ORB-2-3-continuity-cadence.md`, `ORB-4-audio-ready.md` (each includes the matching `orb-widget.js?v=` cache-bust bump).
- [ ] Apply the **`orb-agent` patches** before claiming LiveKit parity in prod:
  `ORB-2-3-continuity-greeting.py`, `ORB-4-audio-ready.py`, `ORB-5-autopilot-cta.py`, `phaseA-bootstrap-cap.py`.
- [ ] Live smokes per phase (dragan3 + dragan1, Vertex **and** LiveKit canary) — see each phase block below.

## Bucket 3 — POST-MERGE FOLLOW-UPS (tracked engineering, not release blockers)

- [ ] **#2435:** wire `handleLiveSessionStart` hydration from `orb_session_state` + `decideGreetingPolicyAuthoritative` refactor + call `recordWakeTurn` on each meaningful turn (needs live session).
- [ ] **#2437:** implement the greeting-release gate (`connectToLiveAPI`/wake-brief waits ack-or-3s; LiveKit `wait_for_audio_ready`) — needs live-session timing.
- [ ] **#2438:** persist `pending_cta` in `orb_session_state` for cross-transport "yes" resolution.
- [ ] **#2439:** build `GET /api/v1/admin/orb-recovery-health` + cockpit card; run the synthetic Playwright flow on vitanaland.com (both providers).
- [ ] **#2432 DECISION:** add the flag-gated "refuse anonymous on authenticated surface (401)" rule once the `orb.session.identity.resolved` metric confirms drift is gone.
- [ ] **Phase B (#2411):** `VOICE_RANKING_SHADOW` 48h → verify overlap/char-drop → canary `BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL` on dragan1 24h → expand.
- [ ] **Phase A → D:** promote the stdout `[voice.instruction.budget_trimmed]` signal to the typed OASIS topic (the topic already exists from #2408).

---

# PER-PHASE DETAIL (reference)

## Phase Re-Apply

- [ ] Merge PR #2400 — https://github.com/exafyltd/vitana-platform/pull/2400 (VTID-03184 plan_phase branching re-apply)
- [ ] Merge PR #2401 — https://github.com/exafyltd/vitana-platform/pull/2401 (BOOTSTRAP-i18n-llm-locale re-apply)
  - Order independent; disjoint file sets.
- [ ] After each merge, confirm EXEC-DEPLOY SUCCESS, then:
  ```bash
  curl -sS https://gateway-86804897789.us-central1.run.app/alive
  ```
- [ ] Real-account acceptance:
  - dragan3 mobile audio still works after VTID-03184 deploy.
  - dragan3 mobile audio still works after i18n deploy.
  - No regression in characterization snapshots (CI covers).

---

## Phase A — Bootstrap context hard cap

- [ ] Merge PR #2403 — https://github.com/exafyltd/vitana-platform/pull/2403 (`BOOTSTRAP-orb-bootstrap-cap`)
- [ ] After EXEC-DEPLOY SUCCESS:
  ```bash
  curl -sS https://gateway-86804897789.us-central1.run.app/alive
  ```
- [ ] Real-account acceptance:
  - dragan3 (under cap) mobile audio plays normally.
  - dragan1 (pruned to 200 items) mobile audio plays normally.
  - Synthetic 50 KB bootstrap → `[voice.instruction.budget_trimmed]` appears in Cloud Logging.
- [ ] Apply orb-agent LiveKit parity patch in a full checkout:
  `docs/patches/orb-agent/phaseA-bootstrap-cap.py` → `services/agents/orb-agent/session.py`
- [ ] (Phase D follow-up) Promote the stdout `[voice.instruction.budget_trimmed]` signal to the typed `voice.instruction.budget_trimmed` OASIS topic.

---

## Phase D — Observability + hygiene

- [ ] Merge PR #2408 — https://github.com/exafyltd/vitana-platform/pull/2408 (DEV-COMHU-voice-budget-watch)
- [ ] **Verify `exec_sql(query, params)` RPC exists in Supabase** before relying on live data (route + cron depend on it).
- [ ] After EXEC-DEPLOY SUCCESS:
  ```bash
  curl -sS https://gateway-86804897789.us-central1.run.app/alive
  curl -sS "https://gateway-86804897789.us-central1.run.app/api/v1/admin/voice-budget-watch?limit=50&min_pct=10" -H "Authorization: Bearer <ADMIN_JWT>"
  ```
- [ ] Load `/command-hub/voice-budget.html` as admin → dragan1 ≈190%, dragan3 ≈17.6%, sortable, red highlight ≥70%.
- [ ] Confirm first nightly (03:00 UTC) run emits ≥1 `voice.instruction.budget_at_risk` OASIS event.

> NOTE: `Gateway Service Tests` CI runs against live Supabase/Gemini secrets and is intermittently flaky. A lone failure on that check is usually a flake — re-trigger (push an empty commit) before investigating.

---

## Phase B — Relevance-ranked retrieval

- [ ] Merge PR #2411 — https://github.com/exafyltd/vitana-platform/pull/2411 (BOOTSTRAP-orb-memory-ranker)
- [ ] Enable `VOICE_RANKING_SHADOW` (DB/env flag), run 48h on prod traffic.
- [ ] Confirm shadow `compareSelections`: ranked overlap ≥80% with most-important naive selection AND ≥40% char drop on heavy users.
- [ ] Canary `BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL` on dragan1 for 24h, verify audio + greeting quality, then expand.
- [ ] (Optional) thread an intent embedding into `selectMemoryHits` to activate the similarity term.

---

## Phase C — RAG-only memory (DESIGN GATE — founder approval required)

- [ ] **Founder: review & approve** design doc PR #2412 — https://github.com/exafyltd/vitana-platform/pull/2412 (`docs/architecture/voice-rag-only-memory.md`)
  - Answer §10: (1) facts+digest-in-setup / bulk-on-demand split OK for greeting richness? (2) +100–300 ms on recall turns OK? (3) any source to keep inlined?
- [ ] Only after approval: implement Phase C behind `MEMORY_ON_DEMAND_RAG` per design §7 (shadow → dragan1 canary → cohort).
- [ ] **No code merges for Phase C until this gate clears.**

---

## Phase ORB-0.1 — Cross-provider speaking-state watchdog

- [ ] Merge PR #2431 — https://github.com/exafyltd/vitana-platform/pull/2431 (DEV-COMHU-0501)
- [ ] After EXEC-DEPLOY SUCCESS: `/alive` 200; confirm `orb-widget.js?v=20260531-DEV-COMHU-0501-speaking-watchdog` served.
- [ ] Apply vitana-v1 companion patch: `docs/patches/vitana-v1/ORB-0.1-speaking-watchdog.md` (cache-bust bump + LiveKit frame-stamp audit).
- [ ] Community smoke: multi-chunk Vertex turn → watchdog silent; simulated stalled LiveKit subscription → "Vitana speaking" clears within ~2s.

---

## Phase ORB-1 — Auth contract

- [ ] Merge PR #2432 — https://github.com/exafyltd/vitana-platform/pull/2432 (DEV-COMHU-0502)
- [ ] Apply vitana-v1 companion patch: `docs/patches/vitana-v1/ORB-1-auth-contract.md` (reactive setAuth in useOrbVoiceClient + useLiveKitVoice; clearAuth on logout; cache-bust).
- [ ] After EXEC-DEPLOY SUCCESS: `/alive` 200.
- [ ] Acceptance: login dragan3 → `orb.session.identity.resolved` shows is_anonymous=false + memory/cadence; logout → no silent authenticated drift; dragan1↔dragan3 switch → no leak; verify both Vertex + LiveKit canary.
- [ ] **DECISION:** add the flag-gated "refuse anonymous on authenticated surface (401)" hard rule? Deferred so it can't break legitimately-anonymous public sessions; the identity event makes the drift observable first.

---

## Phase ORB-2+3 — Close/reopen continuity + cadence

- [ ] **Apply migration** `supabase/migrations/20260606000000_DEV_COMHU_0503_orb_session_state.sql` (creates orb_session_state + orb_session_state_gc()).
- [ ] Merge PR #2435 — https://github.com/exafyltd/vitana-platform/pull/2435 (DEV-COMHU-0503)
- [ ] Apply orb-agent patch: `docs/patches/orb-agent/ORB-2-3-continuity-greeting.py` (honor skip/brief_resume + continuity hydration).
- [ ] Apply vitana-v1 patch: `docs/patches/vitana-v1/ORB-2-3-continuity-cadence.md` (cache-bust + reset() on logout).
- [ ] **Follow-up (needs live session):** wire handleLiveSessionStart hydration from orb_session_state (conversationId / transcript / lastTurnAt) + decideGreetingPolicyAuthoritative refactor; call recordWakeTurn on each meaningful turn.
- [ ] After EXEC-DEPLOY SUCCESS: `/alive` 200.
- [ ] Acceptance: close+reopen <60s → never `first`; reopen <15min → no repeat daily summary; logout → no leak (dragan1↔dragan3); LiveKit honors decisions.

---

## Phase ORB-4 — Audio-ready handshake

- [ ] Depends on ORB-2+3 migration (orb_session_state) applied.
- [ ] Merge PR #2437 — https://github.com/exafyltd/vitana-platform/pull/2437 (DEV-COMHU-0504)
- [ ] **Follow-up (needs live session):** implement the greeting-release gate in connectToLiveAPI/wake-brief trigger (wait ack-or-3s) per patch; LiveKit agent wait_for_audio_ready.
- [ ] Apply orb-agent patch: `docs/patches/orb-agent/ORB-4-audio-ready.py`.
- [ ] Apply vitana-v1 patch: `docs/patches/vitana-v1/ORB-4-audio-ready.md` (cache-bust + optional LiveKit ack).
- [ ] Acceptance: delayed unlock → greeting waits for ack; 3s timeout → greeting proceeds; reconnect <15min → no re-send.

---

## Phase ORB-5 — Autopilot CTA contract

- [ ] Merge PR #2438 — https://github.com/exafyltd/vitana-platform/pull/2438 (DEV-COMHU-0505)
- [ ] Apply orb-agent patch: `docs/patches/orb-agent/ORB-5-autopilot-cta.py` (declare activate_recommendation + pending-CTA preference).
- [ ] **Follow-up (needs live session):** persist pending_cta in orb_session_state for cross-transport "yes" resolution.
- [ ] Acceptance: every permission offer carries executable CTA; "yes" → activate_recommendation(id); unauthorized → truthful fallback; both providers.

---

## Phase ORB-6 — E2E regression + observability

- [ ] Merge PR #2439 — https://github.com/exafyltd/vitana-platform/pull/2439 (DEV-COMHU-0506)
- [ ] Implement `GET /api/v1/admin/orb-recovery-health` + cockpit card (Command Hub edit) per `docs/superpowers/plans/orb-recovery-observability-and-e2e.md`.
- [ ] Run the synthetic Playwright flow on vitanaland.com (Vertex + LiveKit canary) per the same doc.

---

## ALL 10 PHASES CODE-COMPLETE (2026-05-31)

Re-Apply (#2400, #2401) · A (#2403) · D (#2408) · B (#2411) · C design-gate (#2412) · ORB-0.1 (#2431) · ORB-1 (#2432) · ORB-2+3 (#2435) · ORB-4 (#2437) · ORB-5 (#2438) · ORB-6 (#2439). Tracking PR: #2402.

**Phase C remains a founder STOP-AND-ASK gate — no code until the design doc (#2412) is approved.**
