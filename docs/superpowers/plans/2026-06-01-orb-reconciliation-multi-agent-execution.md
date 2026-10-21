# ORB Reconciliation — Multi-Agent Execution Harness

**Status**: READY TO DISPATCH.
**Date**: 2026-06-01.
**Owner**: Coordinator agent (one), fanning out to lane agents (many).

## 0. WHAT THIS DOCUMENT IS (and is not)

This is an **execution overlay**, not a new plan. It does NOT replace, supersede,
or re-scope either of the two canonical plans. It only describes **how to run them
in parallel with multiple agents** without merge collisions or lost coordination.

The two source plans remain the single source of truth for *what* to build:

| Plan | Phases | Role |
|---|---|---|
| `2026-05-30-vitana-assistant-original-plan-reconciliation.md` | R0–R9 | Strategic (the endpoint) |
| `2026-05-29-orb-recovery-autonomous-execution.md` | Re-Apply, A, B, C, D, ORB-0.1, ORB-1, ORB-2+3, ORB-4, ORB-5, ORB-6 | Tactical (Memory + Recovery streams) |

Each lane agent re-fetches its source plan(s) before every phase. This file tells the
harness who owns which phase, which files, in what order, and where the contention is.

### 0.1 Program boundary (READ FIRST)

There are **two separate programs** in flight; this harness covers **only the first**:

| Program | Scope | Owner session | Master doc |
|---|---|---|---|
| **R0–R9** (THIS harness) | ORB contextual-awareness + voice communication | **this session** | the two plans in §0 above |
| **35-day plan** | Google Cloud train/improve of the Vitanaland system (Phase 1 W1→Wn: datasets, fine-tunes, role registry, context source/quality, Intelligence Cockpit, Vertex CustomJobs) | **parallel session** | `.claude/plans/yes-make-a-week-by-week-wild-shore.md` (not in this repo) |

**The one file both programs touch** is `services/gateway/src/services/awareness-unified-context.ts`
(R1). Per operator decision (2026-06-01): **the R0–R9 session owns it**; the 35-day
session **consumes the frozen `UnifiedAwarenessContext` interface read-only** for its
role-aware context pack and never writes the builder. This is the only cross-program seam.

---

## 1. CURRENT STATE (do not re-do shipped work)

Carried forward from the reconciliation plan's Execution Log + `2026-05-29-pending-human-actions.md`:

| Item | VTID | PR | State |
|---|---|---|---|
| Turn-1 wake-decision observability | VTID-03210 | #2427 | **shipped + deployed** (rev gateway-03720) |
| Bootstrap deploy hotfix (node_modules symlink) | — | #2433 | **shipped** |
| Teacher atomicity (= reconciliation **R3**) | VTID-03218 | #2444 | **shipped + deployed** (rev gateway-03732) |
| Vertex turn-1 collision (was "PR-3") | — | — | **retired** as no-op (journey block is set-but-unread) |
| Greeting-policy decay floor (dragan1 reopen-silence) | VTID-03226 | #2440? | **shipped** |
| dragan3 double-greeting (LiveKit double-injection §E) | — | — | **OPEN — next** |
| **R1 slice 1** — canonical spoken-first-name resolver | VTID-03248 | #2484 | **shipped** by the 35-day session; **R1 ownership now transfers to this session** for the remaining slices |

**Net effect on the DAG**: R3 is effectively done (verify in CI gate only). R1 slice 1
(first-name resolver) is shipped — remaining R1 slices (journey / life_compass /
vitana_index / cadence + collapsing the duplicate fetches) are **this session's** work.
Everything else below is open.

**Consumed (not owned) from the 35-day program** — read-only dependencies, do NOT edit:
`assistant-role-registry.ts` (VTID-03240), `role-aware-context-pack-shadow.ts`
(VTID-03241), `context-source-health.ts` / context-source inventory (VTID-03238). If R1
needs a field these expose, consume it through their interface; never fork it.

---

## 2. TOPOLOGY

```
                          ┌────────────────────┐
                          │   COORDINATOR (1)  │  owns: plan files, state tables,
                          │                    │  VTID allocation, shared-file
                          │                    │  merge serialization, STOP-AND-ASK
                          └─────────┬──────────┘
        ┌───────────┬───────────┬───┴───────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Lane D0 │ │ Lane MEM│ │ Lane OBS│ │ Lane AW │ │ Lane TCH│ │ Lane PRV│   ... + Lane RCV, Lane GATE
   │ Vertex  │ │ Memory  │ │ Cockpit │ │Awareness│ │ Teacher │ │Providers│
   │ diagnose│ │ stream  │ │ + obs   │ │ unify   │ │ track   │ │  (new)  │
   └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

**8 lanes + 1 coordinator.** Lane count is deliberately small: it equals the number of
**disjoint file-ownership zones**, not the number of phases. More agents than disjoint
zones just creates rebase thrash on the two shared hub files (§4).

---

## 3. LANE DEFINITIONS

Each lane owns a set of phases and an exclusive file zone. "Code-complete" (per both
source plans' sandbox rules) = **branch + draft PR + `npm run build` green + `jest`
green + source plan status line updated**. Live-Vertex validation is NOT required for
code-complete; it is the coordinator's post-merge gate.

### Lane D0 — Vertex Post-Login Diagnosis (THE BLOCKER)
- **Phases**: Reconciliation **R0**.
- **Output**: written diagnosis only — no code change.
- **Owns**: `docs/superpowers/plans/` diagnosis artifact + `pending-human-actions.md`.
- **Start gate**: immediate (Wave 0).
- **Why it gates**: until R0 returns a written diagnosis, no lane's change can be
  *validated on Vertex*. Lanes may reach **code-complete** in parallel; they may NOT be
  declared **verified** (merged + smoked) until D0 closes.
- **STOP-AND-ASK**: if the bug is isolated to a specific production data row, list
  candidate rows for human review before any deletion (reconciliation §7.1).

### Lane MEM — Memory Resilience stream
- **Phases**: tactical **Re-Apply** (VTID-03184 + i18n-llm-locale pair) → **A** (bootstrap
  context hard cap) → **B** (relevance-ranked retrieval) → **C** (RAG-only, **STOP-AND-ASK**).
- **Owns**: `services/gateway/src/services/context-pack-builder.ts`, retrieval/ranking
  modules, bootstrap-pack code. Re-Apply cherry-picks PR #2390 (sha 6f37bcdd) +
  PR #2392 (sha 8e7570e3) onto fresh branches.
- **Shared-file touch**: Phase **A** edits `live-system-instruction.ts` (cap injection) →
  must serialize through coordinator (§4).
- **Start gate**: Re-Apply can start at Wave 0 but only **merges** after D0 (the reverts
  were a misdiagnosis; re-applying before D0 risks repeating it). A/B build in parallel.
- **STOP-AND-ASK**: Phase C (RAG-only architecture) — gate before any code.

### Lane OBS — Observability + Cockpit
- **Phases**: tactical **D** (observability + hygiene) + **ORB-6** observability panels.
- **Owns**: cockpit/observability surfaces. Frontend pieces touch
  `services/gateway/src/frontend/command-hub/**` → **requires `DEV-COMHU-XXXXX`** in PR
  title or branch name (Path Ownership Guard CI will fail otherwise).
- **Shared-file touch**: none on the two hubs.
- **Start gate**: immediate (Wave 0). Almost entirely additive — best early lane.

### Lane AW — Unified Awareness (the serialization hub + cross-program seam)
- **Phases**: reconciliation **R1** — slice 1 (first-name resolver, VTID-03248) **already
  shipped**; this lane now drives the **remaining slices** (journey / life_compass /
  vitana_index / cadence + collapsing the duplicate fetches) → then **R2** (delete legacy
  greeting-policy block).
- **Owns (existing file, ownership transferred here)**:
  `services/gateway/src/services/awareness-unified-context.ts`. This is the **only file the
  35-day program also depends on** — it consumes the exported `UnifiedAwarenessContext`
  interface **read-only**. Before changing the interface's shape, announce it so the 35-day
  session can re-pin; never break their role-aware-context-pack consumer silently.
- **Owns (edit)**: `services/gateway/src/orb/live/session/live-session-controller.ts`
  (collapse 4 legacy fetches), `services/gateway/src/orb/live/instruction/live-system-instruction.ts:413-528`
  (delete), `voice-wake-brief.ts` (absorb temporal fallback pools).
- **Start gate**: immediate (Wave 0) — but R1 is the **dependency root** for AW/TCH/PRV
  parity work. Land R1 first; lanes TCH/PRV consume its `UnifiedAwarenessContext` shape.
- **Contention**: touches BOTH hub files. Coordinator serializes its merges against
  Lane MEM (Phase A) and Lane RCV (ORB-1, ORB-2+3).

### Lane TCH — Teacher track
- **Phases**: reconciliation **R3** (atomic select+content — **already shipped, verify
  only**) → **R4** (graduated-user track).
- **Owns**: `services/gateway/src/services/assistant-continuation/providers/teacher/feature-discovery-teacher.ts`,
  `services/gateway/src/orb/teacher/teacher-content-resolver.ts`, `system_capabilities`
  seeds, new `teacher_capability_refresh_schedule` table (migration as a file only).
- **Depends on**: R1 (consumes `UnifiedAwarenessContext.teacher`).
- **STOP-AND-ASK**: R4 default refresh strategy (deepening / Autopilot-curation /
  silence) is a product decision (reconciliation §7.2).

### Lane PRV — New continuation providers
- **Phases**: reconciliation **R6** (`first-time-welcome`, priority 95) + **R7**
  (`goal-completion-inquiry`, priority 92).
- **Owns (new dirs)**: `.../providers/first-time-welcome/`, `.../providers/goal-completion-inquiry/`.
- **Depends on**: R1 (context shape). Otherwise disjoint — clean parallel lane.
- **STOP-AND-ASK**: R6 welcome script + R7 goal-completion detection logic are product
  content/decisions (reconciliation §7.3, §7.4) — open content PRs, ask before merge.

### Lane RCV — Recovery / transport
- **Phases**: tactical **ORB-0.1** (speaking-state watchdog) → **ORB-1** (auth contract) →
  **ORB-2+3** (close/reopen continuity + cadence, new `orb_session_state` table) →
  **ORB-4** (audio-ready handshake) → **ORB-5** (autopilot CTA). Also picks up the OPEN
  dragan3 double-greeting fix.
- **Owns**: transport/session-state/widget code + the new `orb_session_state` /
  `wake_cadence` table migration (file only).
- **Shared-file touch**: ORB-1 + ORB-2+3 edit `live-system-instruction.ts` → serialize (§4).
- **Some phases touch command-hub** → `DEV-COMHU-XXXXX` marker required.

### Lane GATE — Parity + Acceptance
- **Phases**: reconciliation **R8** (cross-provider parity) + **R9** (acceptance contract /
  regression gate) + tactical **ORB-6** E2E suites.
- **Owns**: CI workflow + characterization/E2E test files. `services/agents/orb-agent/session.py`
  is **out-of-sandbox** — write parity changes as `docs/patches/orb-agent/<phase>.py` with
  a docstring header (sandbox rule), do NOT edit the live agent.
- **Start gate**: runs LAST — depends on R1–R7 + the recovery phases reaching code-complete.

---

## 4. SHARED-FILE CONTENTION PROTOCOL (the only real risk)

Exactly **two files** are written by more than one lane. Everything else is disjoint.

| Shared file | Lanes/phases that touch it | Serialization rule |
|---|---|---|
| `services/gateway/src/orb/live/instruction/live-system-instruction.ts` | AW (R2), MEM (A), RCV (ORB-1, ORB-2+3) | One open PR against this file at a time. Coordinator grants a write-lock token; holder rebases on `origin/main`, merges, releases. Next holder rebases before opening. |
| `services/gateway/src/orb/live/session/live-session-controller.ts` | AW (R1, R2), TCH (R3 consume) | Same write-lock. AW lands R1 first; TCH rebases onto it before wiring R4. |

**Merge order on the hub files** (coordinator-enforced): `AW R1` → `MEM A` → `AW R2` →
`RCV ORB-1` → `RCV ORB-2+3`. Each holder runs a clean rebase on `origin/main` immediately
before merge; characterization snapshots must show **no instruction-body diff** unless the
phase explicitly intends one.

---

## 5. DEPENDENCY DAG (combined)

```
D0 (R0 diagnose) ──────── BLOCKS all *verification* (merges/smokes), not code-complete
   │
   ├─ MEM: Re-Apply(pair) ── merges after D0 ──┐
   │        └─ A ──┐                           │
   │               ├─ B ── C (STOP-ASK)        │
   ▼               ▼                           │
AW R1 ──┬── AW R2 (after A on hub file)        │
        ├── TCH R3(done) ── R4                 │
        ├── PRV R6                             │
        └── PRV R7                             │
RCV: 0.1 ── ORB-1 ── ORB-2+3 ── ORB-4          │
                              └── ORB-5        │
OBS: D + ORB-6 panels (parallel, additive) ────┘
                                   │
                                   ▼
                       GATE: R8 parity ── R9 acceptance + ORB-6 E2E
```

---

## 6. WAVE 0 — what starts immediately

Dispatch these lanes **now**, in one batch:

1. **D0** — Vertex diagnosis (blocker; produces the log/diagnosis everything validates against).
2. **AW** — R1 unified awareness (dependency root for TCH/PRV/parity).
3. **OBS** — Phase D cockpit (additive, no hub-file contention, unblocks ORB-6 panels).
4. **MEM** — Re-Apply branches prepared + Phase A built to code-complete (merge held for D0).
5. **PRV** — R6/R7 scaffolds against the R1 context interface (merge held for R1).
6. **RCV** — ORB-0.1 watchdog + the OPEN dragan3 double-greeting fix.

Lanes **TCH-R4**, **MEM-B/C**, and **GATE** start once their upstream (R1 / Phase A /
R1–R7) reaches code-complete.

---

## 7. COORDINATOR RESPONSIBILITIES

1. **VTID allocation** — allocate one VTID per PR via
   `POST gateway.vitanaland.com/api/v1/vtid/allocate`; confirm `status: allocated` before
   the lane opens its PR (collision-at-merge rule: re-allocate if a parallel session takes it).
2. **Hub-file write-lock** — grant/revoke the single write token for the two §4 files.
3. **State tables** — keep the source plans' state tables current (reconciliation §3
   table; tactical §3 table). Append run-log lines; never branch-fork a plan file.
4. **Marker enforcement** — every gateway commit carries `VTID-XXXXX`/`BOOTSTRAP-XXXX`;
   every command-hub-frontend PR carries `DEV-COMHU-XXXXX` in title/branch.
5. **STOP-AND-ASK routing** — Phase C, R4 strategy, R6 script, R7 detection, R0
   data-deletion: park the lane and escalate via `AskUserQuestion`; do not let the lane proceed.
6. **Verification gate** — no PR is "verified" (vs code-complete) until D0 is closed and
   the post-deploy Vertex+LiveKit smoke passes for dragan3 + dragan1 + the synthetic account.

---

## 8. PER-LANE DISPATCH PROMPT (template)

Each lane agent gets this, with `{LANE}`, `{PHASES}`, `{SOURCE_PLAN}`, `{FILE_ZONE}` filled in:

```
You are lane {LANE} of the ORB reconciliation multi-agent run. Your phases: {PHASES}.

Source of truth — re-fetch before each phase:
  curl -sS https://raw.githubusercontent.com/exafyltd/vitana-platform/main/{SOURCE_PLAN}
Harness overlay (file ownership + contention): docs/superpowers/plans/2026-06-01-orb-reconciliation-multi-agent-execution.md

Your exclusive file zone: {FILE_ZONE}. Do NOT edit files outside it. If your phase needs a
hub file (live-system-instruction.ts or live-session-controller.ts), request the write-lock
token from the coordinator first, rebase on origin/main, merge, release.

Definition of code-complete: branch off origin/main + draft PR + `npm run build` green +
`jest` green + source-plan status line updated. Do NOT merge to main, run EXEC-DEPLOY, do
prod smokes, write Supabase prod, edit vitana-v1, or edit services/agents/orb-agent/session.py
(write those as docs/patches/...). Log out-of-sandbox items to
docs/superpowers/plans/2026-05-29-pending-human-actions.md.

Invariants: every gateway commit needs a VTID/BOOTSTRAP marker; command-hub-frontend PRs
need DEV-COMHU in title/branch; every PR body states "Vertex parity ✓ / LiveKit parity ✓"
with file-level evidence. Greeting/Teacher/journey work is community-only — never test on
Command Hub. Don't revert at first suspicion — diagnose with logs + DB first.

STOP-AND-ASK at the gates your phase lists. Otherwise: silent, continuous. Report at
code-complete, at a STOP-AND-ASK gate, or if >2 PRs fail CI without explanation.
```

Test accounts (all lanes): dragan3 `c5a4daf9-190a-4a9e-9638-d6b32f85244a` (LiveKit allowlist),
dragan1 `0adc6ff6-acb0-4dca-99d0-295211a40e3e`, synthetic `a27552a3-0257-4305-8ed0-351a80fd3701`
(create fresh for D0 — no data, NOT on LiveKit allowlist).

---

## 9. INTEGRATION CADENCE

- **Continuous merges** for disjoint lanes (OBS, PRV, TCH, RCV non-hub phases) once
  code-complete + CI green + (for behavior changes) D0 closed.
- **Serialized merges** for the two hub files per §4 write-lock.
- **Daily integration checkpoint**: coordinator rebases all open lane branches on
  `origin/main`, refreshes both source plans' state tables, and re-confirms no two open
  PRs touch the same hub file simultaneously.
- **Acceptance = reconciliation §3 R9**: all 9 scenarios pass automatically on every PR,
  on BOTH Vertex and LiveKit. That green gate is the terminal state of this run.

---

## 10. WHAT THIS HARNESS DELIBERATELY DOES NOT DO

- It does not invent new phases, providers, or scope beyond R0–R9 + the tactical phases.
- It does not parallelize the two hub files — they are explicitly serialized.
- It does not merge or deploy autonomously past the sandbox boundary — those stay
  out-of-sandbox and logged for human action.
- It does not claim more lanes than there are disjoint file zones.

End of harness.
