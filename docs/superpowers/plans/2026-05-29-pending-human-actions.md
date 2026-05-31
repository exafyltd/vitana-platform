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
