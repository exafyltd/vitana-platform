# ORB R0–R9 — Autonomous Execution Decisions Log

**Mode**: full autonomous, no per-step approval (operator waived supervision 2026-06-01).
**Owner**: coordinator session (R0–R9 program).

The operator authorized non-stop end-to-end execution with no questions. Where the
plans define STOP-AND-ASK product gates, the coordinator makes the call here and proceeds;
each decision is logged for later review. Production merge + EXEC-DEPLOY + prod smoke remain
the governed terminal step (out-of-sandbox) and are NOT performed autonomously.

## Gate decisions taken

| Gate | Plan ref | Decision taken | Rationale |
|---|---|---|---|
| **R4 graduated-Teacher strategy** | reconciliation §7.2 | Default = **deepening refresh** of a `tried` capability (next-level framing), gated by a new `teacher_capability_refresh_schedule` (90-day per user×capability). If nothing eligible → **graceful one-time pause** line, then silent. | Keeps the long-tail user (dragan1) engaged without re-offering completed items; least surprising of the three options. |
| **R6 first-time-welcome script** | reconciliation §7.3 | Author EN + **real DE** self-intro (~4–5 sentences): "I'm Vitana, your longevity companion…" + names the 90-day default plan + invites the first goal. Fires once (`is_first_session=true`), then flips it false. | Content is reversible (DB/seed); a sensible default unblocks the provider; DE is a real translation per the i18n rule. |
| **R7 goal-completion detection** | reconciliation §7.4 | Trigger = `life_compass.target_date` in the **past (end-of-day UTC)** via the canonical R1 resolver; **one-time per goal**. On confirm → Life Compass setup flow; old goal → `is_active=false`. Does NOT require Autopilot metric confirmation. | Deterministic, testable, matches the R1 `plan_phase=goal_completed` definition; metric-confirmation can be layered later. |
| **Phase C RAG-only memory** | orb-recovery §4.C | **Design-only** — produce the architecture doc + feature-flagged scaffold (`FEATURE_RAG_ONLY=off`); do NOT change memory behavior autonomously. | A wholesale memory-architecture swap is too consequential to ship unsupervised even under full-auto; the R0-fix + Phase A already remove the acute overflow risk. |
| **R0 data deletion** | reconciliation §7.1 | **Not triggered** — R0 root cause is instruction size, not a poison data row; no deletion needed. | Diagnosis stands on code evidence. |

## Hard boundaries kept (even under full-auto)
- No merge to `main`, no EXEC-DEPLOY, no prod Cloud Run deploy, no Supabase prod writes (migrations written as files only).
- `services/agents/orb-agent/session.py` edited only as `docs/patches/orb-agent/*` files.
- Every gateway commit carries a `BOOTSTRAP-*` marker; real `VTID-*` allocated at merge.
- Hub files (`live-system-instruction.ts`, `live-session-controller.ts`) serialized via the harness write-lock.

## Execution waves
- **Wave 1 (done, CI-green, ready):** R0-fix #2492, R1 slice 2 #2493, RCV double-greeting #2491.
- **Wave 2 (dispatched):** R6+R7 providers, R4 graduated Teacher, Phase B relevance retrieval, R5 re-apply reverts.
- **Wave 3 (hub-serialized):** R1 builder (collapse fetches), R2 (delete greeting policy), ORB-1 auth, ORB-2+3 continuity+cadence, ORB-4 handshake, ORB-5 autopilot CTA, ORB-0.1 watchdog.
- **Wave 4 (final):** R8 parity tests, R9 10-case acceptance gate, ORB-6 E2E.
