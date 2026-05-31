# ORB Communication Recovery + Memory Resilience — Autonomous Execution Plan

**Status**: LIVE. Updated incrementally; agent must `git pull` before each phase.
**Owner**: Claude (autonomous multi-agent harness).
**Started**: 2026-05-29.
**Single source of truth**: this file in `main`. Do NOT branch-fork the plan.

---

## 0. PREAMBLE — read in full before any action

### 0.1 What this plan is

A 10-phase end-to-end repair of the Vitana ORB voice surface. Two failure classes are being fixed in one engagement:

1. **Memory resilience**: heavy community users accumulate `memory_items` + `memory_facts` to the point that the post-login Vertex `system_instruction` exceeds the ~32 KB Vertex Live API budget. Vertex silently fails setup → no TTS frames. Affects every long-term active user within months. (Phases Re-Apply, A, B, C, D.)
2. **ORB Recovery Plan v1**: 6 architectural fixes in the existing recovery doc at `docs/superpowers/plans/2026-05-29-orb-communication-recovery.md`. Covers: audio queue closure (already shipped — VTID-03185), auth contract drift, close/reopen continuity loss, missing cadence writer, audio-ready handshake race, autopilot CTA contract mismatch. (Phases 0.1, 1, 2+3, 4, 5, 6.)

### 0.2 Operating mode

- **Fully autonomous**. No human-in-the-loop except where this document explicitly says STOP-AND-ASK.
- **24/7 until acceptance is green** for all phases.
- **Multi-agent**: use the Workflows / Agents feature to fan out independent phases. Two streams below; coordinate on the shared file `services/gateway/src/orb/live/instruction/live-system-instruction.ts`.
- **Verify, don't assume**. Every claim of "done" must be backed by a curl smoke + a real session test on a real account.

### 0.3 Invariants you must never violate

1. Every gateway commit needs a `VTID-XXXXX` or `BOOTSTRAP-XXXX` marker in the commit message. Without it `EXEC-DEPLOY` does NOT dispatch — the change ships to `main` but never reaches Cloud Run.
2. Any commit touching `services/gateway/src/frontend/command-hub/**` needs a `DEV-COMHU-XXXXX` marker in the **PR title** or **branch name**. The `Path Ownership Guard` CI check enforces this and will FAIL the PR otherwise.
3. **Every PR description must include** the line `**Vertex parity ✓ / LiveKit parity ✓**` with file-level evidence. If a change is genuinely Vertex-only or LiveKit-only, write that explicitly and explain why the other path is unaffected.
4. Greeting / Teacher / journey-overview / new-day work is **community-only**. Do not test it on Command Hub. The surface resolver at `services/gateway/src/orb/live/instruction/live-system-instruction.ts:601-622` swaps the persona to `dev_orb` on `/command-hub/*` — your changes won't render.
5. Don't revert PRs at first suspicion. Diagnose with logs + DB introspection first. Two reverts during this engagement (VTID-03184, BOOTSTRAP-i18n-llm-locale) turned out to be wrong direction; root cause was Dragan1's accumulated memory.
6. Don't bypass `--no-verify` or hook signing without a human OK.

### 0.4 How to update this plan

- Each phase has a `Status` line. Update it as you progress: `pending → in_progress → blocked → shipped → verified`.
- Append a `Run log` line under each phase as you act. Format: `YYYY-MM-DD HH:MM UTC — <event>`.
- The plan file lives in `main`. To update, commit on a `plan/` branch and merge via PR. Don't bypass review for plan edits — they're audit trail.
- If a phase becomes blocked, write the blocker under `Notes` and skip to the next independent phase.

---

## 1. QUICK-REFERENCE CARD

### 1.1 Repos

| Repo | Path (local) | Production URL |
|---|---|---|
| `exafyltd/vitana-platform` | `/home/dstev/worktrees/VTID-03168-structural` (use any worktree) | gateway: `https://gateway-86804897789.us-central1.run.app` (`https://gateway.vitanaland.com` custom) |
| `exafyltd/vitana-v1` | `/home/dstev/vitana-v1` | community-app: `https://vitanaland.com` (also `https://community-app-q74ibpv6ia-uc.a.run.app`) |

### 1.2 Credentials (already loaded in local env)

- **Vitana Platform PAT**: stored; `gh` CLI works directly.
- **Vitana-v1 PAT**: stored; `gh` CLI works directly.
- **Supabase Management API token**: stored locally — read from `~/.claude/settings.local.json` (look for `SUPABASE_ACCESS_TOKEN=sbp_*` substring) OR from the operator's secure note. **Never inline the token in this repo.** Endpoint: `POST https://api.supabase.com/v1/projects/inmkhvwdcuyhnxkgfvsb/database/query` with `Authorization: Bearer <token>` and body `{"query": "<SQL>"}`.
- **Supabase MCP** also available — use `mcp__supabase__*` tools for the same SQL access via a more structured interface.

### 1.3 VTID allocator

Allocate a VTID before any deploy-bound commit:

```bash
curl -sS -X POST "https://gateway-86804897789.us-central1.run.app/api/v1/vtid/allocate" \
  -H "Content-Type: application/json" \
  -d '{
    "target_role": "DEV",
    "spec_status": "approved",
    "status": "in_progress",
    "title": "<short title>",
    "summary": "<one-paragraph summary>",
    "initiator": "claude_code"
  }'
```

Response is JSON like `{"ok":true,"vtid":"VTID-XXXXX","num":XXXXX,"id":"<uuid>"}`.

### 1.4 Test surfaces

| Surface | URL pattern | Resolved as | Persona |
|---|---|---|---|
| Mobile (Appilix Android WebView) | mobile UA + `vitanaland.com` | `vitanaland` (community) | `voice_live` |
| Desktop web | `vitanaland.com` | `vitanaland` (community) | `voice_live` |
| Command Hub | `/command-hub/*` | `command-hub` (developer) | `voice_live` overlaid with `dev_orb` |
| Admin | `/admin/*` | `admin` | `voice_live` (no overlay yet) |

Surface resolution code: `services/gateway/src/orb/live/instruction/live-system-instruction.ts:601-622`.

**For all greeting / Teacher / journey work, test on community (mobile or vitanaland.com), NEVER Command Hub.**

### 1.5 Provider state

- Default upstream provider: **Vertex** (`voice.active_provider = vertex` in `system_config`).
- LiveKit canary: gated by `voice.livekit_canary_enabled` + `voice.livekit_canary_allowlist` in system_config, AND `voice.livekit_agent_enabled` (currently `false` in production).
- Provider selection logic: `services/gateway/src/orb/live/upstream/upstream-provider-selector.ts`.
- Live-active-provider endpoint: `GET /api/v1/orb/active-provider`.
- Both providers must continue working at parity after every phase.

### 1.6 Test accounts

| Vitana ID | User ID | Display Name | Notes |
|---|---|---|---|
| `dragan3` | `c5a4daf9-190a-4a9e-9638-d6b32f85244a` | Dragan (Red) | Clean account, used for happy-path verification |
| `dragan1` | `0adc6ff6-acb0-4dca-99d0-295211a40e3e` | Dragan Alexander (Blue) | Heavy account. **Manually pruned 2026-05-29 to 200 memory_items + 200 memory_facts**. Used for heavy-user verification — must keep working AND must accumulate predictably across subsequent sessions. |
| (synthetic) | `a27552a3-0257-4305-8ed0-351a80fd3701` | e2e-test@vitana.dev | Use for synthetic Playwright flows. Password: `VitanaE2eTest2026!` |

### 1.7 Useful smoke commands

```bash
# Gateway alive
curl -sS https://gateway-86804897789.us-central1.run.app/alive

# Gateway voice health (includes active provider)
curl -sS https://gateway-86804897789.us-central1.run.app/api/v1/orb/live/health | python3 -m json.tool

# Community app serves the bumped cache-bust
curl -sS https://vitanaland.com/ | grep 'orb-widget.js?v='

# Verify deployed widget contains a specific marker
curl -sS https://gateway.vitanaland.com/command-hub/orb-widget.js | grep -c VTID-03185
```

---

## 2. HARD GOVERNANCE RULES (consolidated)

| ID | Rule | Enforcement |
|---|---|---|
| G1 | Commit messages contain VTID/BOOTSTRAP marker | EXEC-DEPLOY parser |
| G2 | Command Hub frontend edits carry DEV-COMHU marker in PR title or branch | `Path Ownership Guard` CI check |
| G3 | PR descriptions state Vertex + LiveKit parity | manual + this plan |
| G4 | After merge → wait for EXEC-DEPLOY SUCCESS → verify `/alive` 200 JSON | required before claiming "deployed" |
| G5 | Frontend cache-bust string bumped on every widget change | required (gateway side + vitana-v1 side) |
| G6 | Tests must pass: characterization snapshots, jest, smoke regression scripts | CI gates |
| G7 | Never delete user-facing data without a backed-up CSV (`SELECT INTO`) first | manual |
| G8 | Never disable hooks, sign-bypass, force-push to main | manual |

---

## 3. STATE MACHINE — current status of all phases

(Agent: update this table as you progress.)

| Phase | VTID | Stream | Status | Branch | PR | Deploy SHA | Notes |
|---|---|---|---|---|---|---|---|
| Re-Apply VTID-03184 | VTID-03184 | Memory | code-complete (pending merge + deploy) | reapply/VTID-03184-plan-phase | #2400 | — | cherry-pick of 6f37bcdd; build+jest green (29 tests) |
| Re-Apply i18n-llm-locale | BOOTSTRAP-i18n-llm-locale | Memory | code-complete (pending merge + deploy) | reapply/i18n-llm-locale | #2401 | — | cherry-pick of 8e7570e3; build green |
| A — Bootstrap context cap | BOOTSTRAP-orb-bootstrap-cap | Memory | code-complete (pending merge + deploy) | fix/BOOTSTRAP-orb-bootstrap-cap | #2403 | — | 12KB hard cap; ALL CI GREEN incl Gateway Service Tests (initial fail was a flake, re-triggered) |
| B — Relevance-ranked retrieval | BOOTSTRAP-orb-memory-ranker | Memory | code-complete (pending merge + deploy) | feat/BOOTSTRAP-orb-memory-ranker | #2411 | — | pure ranker module + 17 unit tests (clamp01 +Inf fix); cpb wiring deferred to shadow/canary rollout (prod-traffic gated) |
| C — RAG-only memory architecture | BOOTSTRAP-orb-rag-only-memory | Memory | DESIGN DOC SHIPPED — awaiting founder approval (gate) | docs/voice-rag-only-memory-design | #2412 | — | design doc only; NO code until approved |
| D — Observability + hygiene | DEV-COMHU-voice-budget-watch | Memory | code-complete (pending merge + deploy) | feat/DEV-COMHU-voice-budget-watch | #2408 | — | route+cron+CHub panel+typed topics; typecheck+build+jest(13) green |
| ORB-0.1 — Cross-provider watchdog | new | Recovery | pending | — | — | — | DEV-COMHU required |
| ORB-1 — Auth contract | new | Recovery | pending | — | — | — | biggest UX lever |
| ORB-2+3 — Continuity + cadence | new | Recovery | pending | — | — | — | one combined PR |
| ORB-4 — Audio-ready handshake | new | Recovery | pending | — | — | — | depends on shared state from 2+3 |
| ORB-5 — Autopilot CTA | new | Recovery | pending | — | — | — | depends on shared state from 2+3 |
| ORB-6 — E2E regression + observability | new | Recovery | pending | — | — | — | parallel with 5 |

**Suggested fan-out for the Workflows harness:**

- Stream **Memory**: Re-Apply (sequential pair) → A → D (parallel) → B → C (STOP-AND-ASK gate).
- Stream **Recovery**: 0.1 → 1 → 2+3 → 4 → 5 (parallel with 6).
- The two streams contend only on `live-system-instruction.ts` (A, 1, 2+3). Land them serially through that file; clear rebase before each merge.

---

## 4. PHASE DEEP-DIVES

### PHASE Re-Apply — restore VTID-03184 and BOOTSTRAP-i18n-llm-locale

**Status**: code-complete (pending merge + deploy)
**Stream**: Memory
**Estimated effort**: 30 min total (two small PRs)

#### 4.Re-A.1 Context

On 2026-05-29, two reverts landed as misdiagnosis when the real cause was Dragan1's accumulated memory (root cause is now fixed by manual prune + Phase A code-side). The two reverted PRs were legitimate work and must come back into trunk:

- **PR #2390** (sha `6f37bcdd`, VTID-03184) — endless-journey `plan_phase` branching on the new-day overview prompt. Reverted by `bb1b8fe3`.
- **PR #2392** (sha `8e7570e3`, BOOTSTRAP-i18n-llm-locale) — gateway LLM callers respect user locale. Reverted by `5329f3ae`.

#### 4.Re-A.2 Action

For each:
1. `git cherry-pick <original-sha>` on a fresh branch off main. If conflicts arise from intervening merges, resolve preserving the original intent.
2. Verify build: `cd services/gateway && npm run build`.
3. Verify tests: relevant suites only — `npx jest test/services/assistant-continuation/providers/new-day-{return,overview-aggregator}.test.ts` for VTID-03184; the i18n PR has no specific test suite but `npm run build` covers it.
4. Open PR with title `feat(overview): VTID-03184 plan_phase branching (re-apply after 2026-05-29 misdiagnosis revert)` and `fix(i18n): BOOTSTRAP-i18n-llm-locale re-apply` respectively. Body explains the 2026-05-29 revert was misdiagnosis (real cause: Dragan1 memory accumulation; fix: Phase A bootstrap cap).
5. Wait for CI green. Merge squash. Wait for EXEC-DEPLOY SUCCESS. Smoke `/alive`. Smoke dragan3 mobile audio (expect: works).
6. Mark phase status `shipped` in the table.

#### 4.Re-A.3 Acceptance

- [ ] VTID-03184 re-applied, deployed, dragan3 mobile audio still works.
- [ ] BOOTSTRAP-i18n-llm-locale re-applied, deployed, dragan3 mobile audio still works.
- [ ] No regressions in characterization snapshots.

#### 4.Re-A.4 Rollback

If either re-apply causes a regression (dragan3 mobile breaks again), revert that specific PR, open a follow-up issue, mark phase status `blocked` with notes, continue with Phase A.

#### 4.Re-A.5 Run log

- 2026-05-30 14:05 UTC — code-complete; both reverts re-applied as clean cherry-picks. VTID-03184 → PR #2400 (draft), build+jest green (29 tests, 4 suites). BOOTSTRAP-i18n-llm-locale → PR #2401 (draft), build green. Sandbox cannot merge/deploy.

#### 4.Re-A.6 Pending human actions

- Merge PR #2400 and PR #2401 (either order — they touch disjoint files: VTID-03184 = `new-day-overview-*.ts`; i18n = `i18n/llm-locale.ts` + knowledge-hub/session-summaries/context-pack-builder/orb-tools-shared).
- Both commit subjects carry their markers (VTID-03184 / BOOTSTRAP-i18n-llm-locale) so EXEC-DEPLOY dispatches on merge.
- After EXEC-DEPLOY SUCCESS for each: verify `/alive` 200 JSON, then smoke dragan3 mobile audio (expect: works).
- See aggregation file `docs/superpowers/plans/2026-05-29-pending-human-actions.md`.

---

### PHASE A — Bootstrap context hard cap (the safety net)

**Status**: code-complete (pending merge + deploy)
**Stream**: Memory
**VTID**: allocate at start, branch name pattern `fix/VTID-XXXXX-bootstrap-context-cap`.
**Estimated effort**: 1 day.

#### 4.A.1 Goal

Make it impossible for any user, however heavy, to break Vertex by overflowing `system_instruction`. This is defensive, not optimal — Phase B improves *what* gets included; Phase A guarantees *something* fits.

#### 4.A.2 Files

- `services/gateway/src/orb/live/instruction/live-system-instruction.ts` (around line 789-798 where `effectiveBootstrap` is appended; add cap logic before append).
- `services/gateway/src/types/cicd.ts` (add new OASIS topic `voice.instruction.budget_trimmed`).
- `services/gateway/test/orb/live/instruction/system-instruction.characterization.test.ts` (existing characterization tests — keep snapshots green; if they change, justify in PR body).
- New test file: `services/gateway/test/orb/live/instruction/bootstrap-cap.test.ts` (unit test the cap logic).

#### 4.A.3 Implementation

```ts
// Constants near the top of live-system-instruction.ts
const BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000;
const TRIM_SENTINEL = (omitted: number) =>
  `\n[context trimmed: ${omitted} chars of older context omitted to fit budget]`;

// Inside buildLiveSystemInstruction, replace the existing append block (~line 789):
let effectiveBootstrap = bootstrapContext ?? '';
let bootstrapTrimmedChars = 0;
if (
  effectiveBootstrap &&
  effectiveBootstrap.includes('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>')
) {
  effectiveBootstrap = stripBrainOpenerSections(effectiveBootstrap);
}
if (effectiveBootstrap.length > BOOTSTRAP_CONTEXT_MAX_CHARS) {
  bootstrapTrimmedChars = effectiveBootstrap.length - BOOTSTRAP_CONTEXT_MAX_CHARS;
  // Trim from the BOTTOM (older content); keep the top which contains
  // identity, role, recent activity (per vitana-brain ordering).
  effectiveBootstrap =
    effectiveBootstrap.slice(0, BOOTSTRAP_CONTEXT_MAX_CHARS) +
    TRIM_SENTINEL(bootstrapTrimmedChars);
  // Fire-and-forget OASIS event (don't block on this).
  void emitOasisEvent({
    type: 'voice.instruction.budget_trimmed',
    source: 'orb-live',
    status: 'warning',
    message: 'bootstrap context exceeded budget; trimmed',
    payload: {
      user_id: userId,
      chars_total: effectiveBootstrap.length + bootstrapTrimmedChars,
      chars_trimmed: bootstrapTrimmedChars,
      cap: BOOTSTRAP_CONTEXT_MAX_CHARS,
    },
  });
}
if (effectiveBootstrap) {
  instruction += `\n\n${effectiveBootstrap}`;
}
```

Add a similar cap for `conversationHistory` (it already caps at 4000; leave it but emit a `voice.instruction.budget_trimmed` event with `kind: 'conversation_history'` when it actually trims).

#### 4.A.4 Tests

`bootstrap-cap.test.ts`:
```ts
describe('bootstrap context cap (VTID-XXXXX)', () => {
  it('passes a 8KB bootstrap through unchanged', () => { ... });
  it('trims a 50KB bootstrap to BOOTSTRAP_CONTEXT_MAX_CHARS + sentinel', () => { ... });
  it('preserves the wake-brief override sentinel after trim', () => { ... });
  it('emits voice.instruction.budget_trimmed event with correct payload', () => { ... });
  it('does NOT emit when bootstrap is under the cap', () => { ... });
});
```

#### 4.A.5 PR description template

```
## Summary
Phase A of ORB Memory Resilience. Adds a 12 KB hard cap on `bootstrapContext` before
concatenation into Vertex `system_instruction`. Prevents heavy users (like dragan1
who accumulated 228 KB of memory) from silently breaking Vertex setup.

## What this PR ships
- Constant `BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000` in live-system-instruction.ts
- Trim-from-bottom + sentinel string when over budget
- New OASIS event `voice.instruction.budget_trimmed`
- Unit tests (bootstrap-cap.test.ts) covering pass-through, trim, sentinel preservation, event emission

## What it does NOT do
- Improve WHICH content gets included (Phase B does that — relevance ranking)
- Cap conversation_history beyond the existing 4 KB limit
- Touch the LiveKit agent (Vertex-only path; LiveKit agent constructs instructions separately)

## Vertex parity ✓
The cap fires only in the Vertex-served path (`buildLiveSystemInstruction`). Vertex
session setup now resilient to memory accumulation.

## LiveKit parity ✓
LiveKit agent (`services/agents/orb-agent/session.py`) does not use this code path.
Worth a separate audit in Phase B to verify the agent's own instruction-building has
an equivalent safety net; tracked as VTID-XXXXX.

## Test plan
- [x] npm run build green
- [x] new unit tests pass (5 cases)
- [x] characterization snapshots: only the new BOOTSTRAP_CONTEXT_MAX_CHARS constant
  appears in the diff; instruction body unchanged for under-cap users
- [ ] Smoke: dragan3 mobile (under-cap) audio plays normally
- [ ] Smoke: dragan1 mobile (recently pruned to 200 items) audio plays normally
- [ ] Synthetic: inject 50 KB context via a test handler → event emitted in OASIS

## Rollback
Single-revert PR. The constant + cap logic is additive; reverting restores prior
behavior (heavy users break, but no other regression).
```

#### 4.A.6 Verification after deploy

```bash
# 1. Alive
curl -sS https://gateway-86804897789.us-central1.run.app/alive

# 2. Synthetic large-bootstrap test: write a dev-only route that builds an
# instruction with 50 KB of bootstrap and returns chars_total, chars_trimmed.
# Or query oasis_events directly to confirm the topic exists and fires.

# 3. Real smoke: open ORB as dragan3 + dragan1, confirm audio + no errors.
```

#### 4.A.7 Acceptance

- [ ] Build green, all tests pass.
- [ ] PR merged, EXEC-DEPLOY SUCCESS, `/alive` 200.
- [ ] dragan3 mobile audio works.
- [ ] dragan1 mobile audio works.
- [ ] Synthetic 50 KB test → `voice.instruction.budget_trimmed` event present in oasis_events.

#### 4.A.8 Run log

- 2026-05-30 14:55 UTC — code-complete. New pure module `bootstrap-cap.ts` (12 KB cap, trim-from-bottom + sentinel) wired into `live-system-instruction.ts`; structured `[voice.instruction.budget_trimmed]` stdout signal on trim (bootstrap + conversation_history). PR #2403 (draft). `npm run build` green; jest `bootstrap-cap.test.ts` 6/6 green.
- 2026-05-30 14:56 UTC — orb-agent LiveKit parity captured as `docs/patches/orb-agent/phaseA-bootstrap-cap.py` (agent file absent from sandbox checkout).

#### 4.A.9 Pending human actions

- Merge PR #2403 (commit marker `BOOTSTRAP-orb-bootstrap-cap` present → EXEC-DEPLOY dispatches).
- After EXEC-DEPLOY SUCCESS: `/alive` 200; dragan3 (under-cap) + dragan1 (pruned) mobile audio play normally; synthetic 50 KB bootstrap → `[voice.instruction.budget_trimmed]` line in Cloud Logging.
- Apply orb-agent parity patch `docs/patches/orb-agent/phaseA-bootstrap-cap.py` in a full checkout (LiveKit agent-side cap).
- Phase D will promote the stdout signal to the typed `voice.instruction.budget_trimmed` OASIS topic (consumers ship there).

---

### PHASE D — Observability + hygiene (parallel with A)

**Status**: code-complete (pending merge + deploy)
**Stream**: Memory
**VTID**: allocate at start.
**Estimated effort**: 2 days. Can run parallel to Phase A.

#### 4.D.1 Goal

See heavy users *before* they break. Stop relying on user reports.

#### 4.D.2 Components

1. **Cockpit panel** in `services/gateway/src/frontend/command-hub/` (already a Command Hub surface — **DEV-COMHU marker REQUIRED** in PR title or branch).
   - New tab or card: "Voice instruction budget".
   - Columns: `vitana_id`, `memory_items_count`, `memory_chars`, `memory_facts_count`, `% of 12 KB cap`, `last_session_at`.
   - Sort by `% of cap` desc. Red highlight ≥70%.
   - Data source: new gateway route `GET /api/v1/admin/voice-budget-watch?limit=50&min_pct=10` returning the top-N users by usage.

2. **Backend route** at `services/gateway/src/routes/voice-budget-watch.ts`:
   ```ts
   router.get('/voice-budget-watch', requireAdminAuth, async (req, res) => {
     const { limit = 50, min_pct = 10 } = req.query;
     const rows = await fetchVoiceBudgetWatch(supabase, { limit, min_pct });
     res.json({ ok: true, rows });
   });
   ```
   Where `fetchVoiceBudgetWatch` runs a SQL query similar to:
   ```sql
   SELECT
     u.user_id,
     u.vitana_id,
     u.display_name,
     COUNT(mi.id) FILTER (WHERE mi.user_id = u.user_id) AS memory_items,
     COALESCE(SUM(LENGTH(mi.content)) FILTER (WHERE mi.user_id = u.user_id), 0) AS memory_chars,
     (SELECT COUNT(*) FROM memory_facts mf WHERE mf.user_id = u.user_id) AS memory_facts,
     ROUND(100.0 * COALESCE(SUM(LENGTH(mi.content)) FILTER (WHERE mi.user_id = u.user_id), 0) / 12000.0, 1) AS pct_of_cap
   FROM app_users u
   LEFT JOIN memory_items mi ON mi.user_id = u.user_id
   GROUP BY u.user_id, u.vitana_id, u.display_name
   HAVING ROUND(100.0 * COALESCE(SUM(LENGTH(mi.content)) FILTER (WHERE mi.user_id = u.user_id), 0) / 12000.0, 1) >= :min_pct
   ORDER BY pct_of_cap DESC
   LIMIT :limit;
   ```

3. **Cron** `voice-instruction-budget-watch` (in `services/gateway/src/services/cron/` or wherever the project's crons live):
   - Runs nightly at 03:00 UTC.
   - Queries the same data as the route.
   - For each user with `pct_of_cap >= 70`, emit OASIS event `voice.instruction.budget_at_risk` with `{ user_id, vitana_id, pct_of_cap, memory_chars }`.
   - For each user with `pct_of_cap >= 100`, emit `voice.instruction.budget_overflow` (more severe; treat as a P2 ticket trigger).

4. **Deferred to a separate VTID**: memory consolidation cron that takes the oldest memory_items per user and LLM-summarizes them into a single "history snapshot" item, deletes the originals. This is part of Phase D but ships AFTER Phase C ships, because RAG-only memory may change how consolidation works.

#### 4.D.3 PR description template

```
## Summary
Phase D of ORB Memory Resilience: observability so we never get blindsided by a
heavy user breaking voice setup again.

## What this PR ships
- New admin route GET /api/v1/admin/voice-budget-watch (top-N users by memory budget usage)
- New Command Hub panel "Voice instruction budget" showing budget pct per user
- Nightly cron voice-instruction-budget-watch emitting voice.instruction.budget_at_risk
  (≥70%) and voice.instruction.budget_overflow (≥100%) OASIS events

## DEV-COMHU-XXXXX marker
Required because this PR touches services/gateway/src/frontend/command-hub/**.

## Vertex parity ✓ / LiveKit parity ✓
This is an observability-only change. Both providers benefit equally because both
hit Vertex's system_instruction budget (LiveKit's python agent has its own instruction
assembly that should also be audited; tracked as VTID-XXXXX follow-up).

## Test plan
- [x] Backend unit: SQL query returns expected shape for dragan1 + dragan3 fixtures
- [x] Cron unit: emits one event per at-risk user
- [x] Manual: load /command-hub/voice-budget — sortable, dragan1 shows ~190%, dragan3
  shows ~17.6% (after pruning) → verifies the math
- [x] Cache-bust bumped in src/frontend/command-hub/index.html
```

#### 4.D.4 Acceptance

- [ ] Route ships, panel renders, cron runs nightly.
- [ ] dragan1 shows on the panel at ~190% of cap (was pruned to 22 KB which is < cap, so actually he'll show as ~190% if you measure against the cap of 12K — adjust min_pct query accordingly).
- [ ] First nightly run after deploy emits at least one `voice.instruction.budget_at_risk` event (for whichever heaviest community user exists).

#### 4.D.5 Run log

- 2026-05-30 15:45 UTC — code-complete. Admin route `GET /api/v1/admin/voice-budget-watch`, pure service `voice-budget-watch.ts`, nightly cron `voice-instruction-budget-watch-cron.ts` (at_risk>=70 / overflow>=100 OASIS events), CSP-compliant Command Hub panel `voice-budget.{html,css,js}`, typed topics in `types/cicd.ts`, wired in `index.ts`. PR #2408 (draft). typecheck + build + jest (13/13) green.
- 2026-05-30 15:10 UTC — NOTE on CI flakes: the `Gateway Service Tests` CI job runs against LIVE Supabase/Gemini secrets and is intermittently flaky. Phase A #2403 failed it once, passed clean on a no-op re-trigger. typecheck/build/full-jest are all green locally (4737 tests). If a draft shows a single Gateway Service Tests failure, re-trigger before investigating.

#### 4.D.6 Pending human actions

- Merge PR #2408 (markers DEV-COMHU-voice-budget-watch + BOOTSTRAP-orb-voice-budget present).
- **Confirm the `exec_sql(query, params)` Supabase RPC exists** (route/cron use it for parameterised SQL); if not, point `fetchVoiceBudgetWatch` at the project's standard SQL path. The one functional dependency to verify before live data flows.
- After EXEC-DEPLOY SUCCESS: `/alive` 200; load `/command-hub/voice-budget.html` as admin → dragan1 ≈190%, dragan3 ≈17.6%; confirm first nightly run emits >=1 `voice.instruction.budget_at_risk`.
- Deferred (separate VTID, post-Phase C): memory-consolidation cron.

---

### PHASE B — Relevance-ranked retrieval

**Status**: code-complete (pending merge + deploy)
**Stream**: Memory
**VTID**: allocate at start.
**Estimated effort**: 2 days.
**Depends on**: Phase A merged (need the cap in place so we can compare ranked vs unranked under the same constraint).

#### 4.B.1 Goal

When the bootstrap context approaches the cap, the cap drops content arbitrarily. Phase B replaces "all memory rows" with a relevance-ranked top-N selection so the content that *stays* is the most useful.

#### 4.B.2 Files

- `services/gateway/src/services/context-pack-builder.ts` (~line 800 where memory hits are fetched).
- `services/gateway/src/services/orb-memory-bridge.ts` (memory read primitive).
- `services/gateway/src/services/feature-flags.ts` (add `BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL` flag).
- New: `services/gateway/src/services/memory-ranker.ts` (pure ranking function).

#### 4.B.3 Implementation

```ts
// memory-ranker.ts
export interface MemoryCandidate {
  id: string;
  content: string;
  importance: number;       // existing column, 0-1
  occurred_at: string;      // existing column, ISO
  embedding?: number[];     // existing column, optional
}

export interface RankInputs {
  candidates: MemoryCandidate[];
  intentEmbedding?: number[];
  now: Date;
  topK: number;             // hard cap on output count
}

export function rankMemory({ candidates, intentEmbedding, now, topK }: RankInputs): MemoryCandidate[] {
  const scored = candidates.map((c) => {
    const importance = clamp01(c.importance ?? 0);
    const recency = recencyDecay(c.occurred_at, now);  // e^(-days/30)
    const similarity = intentEmbedding && c.embedding
      ? cosineSimilarity(intentEmbedding, c.embedding)
      : 0;
    const score = 0.4 * importance + 0.4 * recency + 0.2 * similarity;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((x) => x.c);
}
```

`context-pack-builder.ts`: replace the existing `LIMIT` slice with a `rankMemory` call when `isFeatureLive('BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL')` is true.

#### 4.B.4 Shadow harness

Before flipping the flag in prod, ship a `voice-ranking-shadow` mode that runs BOTH selections (current naive + new ranked) and logs both for comparison. Output to OASIS topic `voice.ranking.shadow_compared` with payload `{ user_id, intent, naive_selection_ids, ranked_selection_ids, naive_chars, ranked_chars, overlap_pct }`. Run for 48h on prod traffic before flipping.

#### 4.B.5 Acceptance

- [ ] `rankMemory` unit-tested with 12 fixtures (heavy user, light user, mixed importance, recent dominant, embedding-match dominant).
- [ ] Shadow harness logs both selections for 100+ sessions.
- [ ] Shadow comparison shows ranked selection has ≥80% overlap with the most-important naive selection AND drops 40%+ of total chars on heavy users.
- [ ] Flag flipped on for `dragan1` first (canary), verified for 24h, then expanded.

#### 4.B.6 Run log

- 2026-05-30 16:05 UTC — code-complete. Pure `memory-ranker.ts` (rankMemory 0.4 imp + 0.4 recency + 0.2 sim, recencyDecay, cosineSimilarity, compareSelections shadow primitive). `context-pack-builder.ts`: both memory-hit selection sites routed through flag-gated `selectMemoryHits` (flag OFF = byte-identical naive slice; ON = ranked top-K; lookup failure = naive fallback). Flags BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL + VOICE_RANKING_SHADOW already existed (default false). PR #2411. typecheck + build + FULL jest (4755 passed) green. 18 ranker unit tests.

#### 4.B.7 Pending human actions

- Merge PR #2411 (marker BOOTSTRAP-orb-memory-ranker).
- Enable `VOICE_RANKING_SHADOW`, run 48h on prod; confirm via `compareSelections` overlap >=80% with most-important naive selection AND >=40% char drop on heavy users.
- Canary `BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL` on dragan1 24h, then expand.
- (Optional deeper integration) thread an intent embedding into the selection site to activate the 0.2 similarity term.

---

### PHASE C — RAG-only memory architecture (STOP-AND-ASK before code)

**Status**: DESIGN DOC SHIPPED (PR #2412) — awaiting founder approval; NO code until approved
**Stream**: Memory
**VTID**: allocate at design-doc commit time.
**Estimated effort**: 1-2 weeks of engineering, ~1 day for the design doc.

#### 4.C.1 Goal

Stop concatenating memory into `system_instruction` entirely. Memory is fetched on demand by the model via `search_memory(query)` tool. Setup instruction stays constant size regardless of user weight. This is the architectural endpoint Phase A + B buy time for.

#### 4.C.2 STOP-AND-ASK gate

This phase changes how Vitana sources personal context. It has product implications: greeting personalization may feel less rich, the model may need to make extra tool calls to recall, latency may increase by 100-300ms per turn for context-heavy queries.

**Before writing code**:
1. Open a design PR (just a markdown file `docs/architecture/voice-rag-only-memory.md`) with:
   - Current state diagram
   - Target state diagram
   - List of memory sources currently concatenated (memory_items, memory_facts, conversation_history, life_compass, vitana_index, autopilot pending, etc.)
   - For each source, decide: stays in setup, moves to on-demand tool, removed
   - Tool surface: does `search_memory` need new modes? new params?
   - Latency budget
   - Migration plan (feature flag, canary, rollout)
   - Risks + mitigations
2. Tag the founder for review with a clear ask: "approve this direction or redirect".
3. WAIT for explicit approval. Don't write code until you see it.

#### 4.C.3 If approved

Spec out the implementation in this section after the design doc lands. Likely shape:
- Feature flag `BOOTSTRAP_MEMORY_ON_DEMAND`.
- `buildLiveSystemInstruction` skips the memory concatenation block when flag is on.
- `search_memory` tool gets a richer return shape (semantic-similarity top-K with provenance).
- The python LiveKit agent gets a parallel implementation.
- E2E test: heavy user (dragan1 after 6 months of accumulation in staging) → instruction size flat, audio plays, "do you remember…" queries trigger `search_memory` calls.

---

### PHASE ORB-0.1 — Cross-provider speaking-state watchdog

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start. **MUST contain DEV-COMHU marker in PR title or branch.**
**Estimated effort**: 1 day.

#### 4.0.1.1 Goal

VTID-03185 fixed the Vertex-path closure bug in `_processQueue`. LiveKit uses WebRTC tracks, not scheduled-sources — different lifecycle, but the same end-user symptom ("Vitana speaking" stuck on, mic gated) can still happen on the LiveKit path through different mechanics. Add a transport-agnostic watchdog inside `orb-widget.js` that:

1. On every audio frame received (regardless of source), record `last_audio_received_at`.
2. Tick every 500ms while `audioPlaying === true`. If 2+ seconds since `last_audio_received_at` AND `scheduledSources.length === 0` AND `audioQueue.length === 0` AND any LiveKit track on the session is in `subscribed` state without active flow → force `audioPlaying = false`, log a diagnostic.
3. Add session-start diagnostics: `[VTOrb] AC state, queue len, sources len, first scheduled, first ended` so we can see what shape the session is in from console logs.

#### 4.0.1.2 Files

- `services/gateway/src/frontend/command-hub/orb-widget.js` (the main change). Find the existing `_waitForAudioEnd` and `_processQueue` and add the cross-provider watchdog as a new method `_speakingStateWatchdog()` invoked on session start.
- `services/gateway/scripts/orb-widget-speaking-watchdog-regression.mjs` (new — pattern matches the existing audio-playback regression script).
- `services/gateway/test/frontend/orb-widget-speaking-watchdog.test.ts` (new jest equivalent).
- `services/gateway/package.json` (add to `smoke:orb-widget` script).
- `services/gateway/src/frontend/command-hub/index.html` (bump cache-bust to `20260530-VTID-XXXXX-speaking-watchdog`).
- `vitana-v1/index.html` (companion cache-bust bump in vitana-v1 repo).

#### 4.0.1.3 Acceptance

- [ ] Watchdog method exists in `orb-widget.js`, gates speaking state on cross-provider quiet detection.
- [ ] Regression script + jest test green.
- [ ] Manual smoke: trigger a Vertex multi-chunk TTS turn → watchdog should NOT fire (active flow). Then simulate stalled subscription on LiveKit → watchdog fires within 2 seconds.
- [ ] DEV-COMHU marker present in PR title.
- [ ] vitana-v1 companion cache-bust PR merged + deployed.

---

### PHASE ORB-1 — Auth contract (the biggest UX lever)

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start.
**Estimated effort**: 2-3 days.

#### 4.1.1 Goal

Today the widget's `_tokenSetByInit` flag permanently disables local token refresh once `init()` runs. If the host shell (vitana-v1 or Command Hub) doesn't call `setAuth(token)` correctly on every token refresh, the widget runs anonymous forever even when the user is logged in. Anonymous sessions skip memory, cadence, last-session info, and authenticated tools. This single bug explains the "I have no access" responses AND the missing-memory complaint AND the missing-cadence complaint AND the "first-time greeting on every reopen" symptom — all of which the existing ORB Recovery Plan attributes to separate causes but actually flow from anonymous drift.

#### 4.1.2 Files

- `services/gateway/src/frontend/command-hub/orb-widget.js` — make `setAuth` reactive, remove `_tokenSetByInit` permanent gate, add `clearAuth()`.
- `services/gateway/src/frontend/command-hub/app.js` — ensure every token-refresh path calls `window.VitanaOrb.setAuth()`.
- `services/gateway/src/orb/live/session/live-session-controller.ts` — add `is_anonymous` telemetry block to `handleLiveSessionStart`.
- `services/gateway/src/routes/orb-livekit.ts` — parallel block for LiveKit token issuance.
- `vitana-v1/src/hooks/useOrbVoiceClient.ts` + `useLiveKitVoice.ts` — call `setAuth(token)` reactively on token state change.
- `vitana-v1` shell — explicit `clearAuth()` call on logout / account switch.

#### 4.1.3 Implementation outline

Widget side:
```js
// REMOVE this anti-pattern:
// if (_s._tokenSetByInit) return;

// REPLACE with:
VitanaOrb.setAuth = function (token) {
  _cfg.token = token || null;
  // If a session is live, propagate the new token to subsequent requests.
  // (No mid-session WS re-auth — that's session lifecycle, not auth refresh.)
};
VitanaOrb.clearAuth = function () {
  _cfg.token = null;
  // Also clear any session-scoped continuity that's identity-bound.
  _s._transcriptHistory = [];
  _s.conversationId = null;
};

// On session open, validate token presence:
function _sessionStart() {
  if (_cfg.authSurface === 'authenticated' && !_cfg.token) {
    _emit('auth_required');
    return;  // refuse to start anonymous on an authenticated surface
  }
  // ... existing flow
}
```

Gateway side — `handleLiveSessionStart`:
```ts
const isAnonymous = !req.identity?.user_id;
emitOasisEvent({
  type: 'orb.session.identity.resolved',
  source: 'orb-live',
  status: 'info',
  message: isAnonymous ? 'session_start_anonymous' : 'session_start_authenticated',
  payload: {
    session_id: session.id,
    has_authorization_header: !!req.headers.authorization,
    auth_valid: !!req.identity?.user_id,
    is_anonymous: isAnonymous,
    tenant_id: req.identity?.tenant_id ?? null,
    user_id: req.identity?.user_id ?? null,
    active_role: req.identity?.active_role ?? null,
    conversation_id: session.conversationId ?? null,
  },
});

// Hard rule: if the surface is community/admin and is_anonymous is true,
// refuse with 401 + code='auth_required_for_surface'.
const surface = resolveSurface(req);
if ((surface === 'vitanaland' || surface === 'admin') && isAnonymous) {
  return res.status(401).json({
    ok: false,
    error: 'auth_required_for_surface',
    surface,
    message: 'Authenticated surface requires a valid Authorization header.',
  });
}
```

#### 4.1.4 Acceptance

- [ ] Synthetic flow: login as dragan3 + open ORB → `Authorization` header present, `is_anonymous=false` in OASIS event, memory + cadence resolved.
- [ ] Logout → next ORB open shows `auth_required` state, does NOT silently start anonymous.
- [ ] Account switch dragan1 → dragan3 → no dragan1 conversation or identity leaks into dragan3 session.
- [ ] Verified on BOTH Vertex AND LiveKit canary.
- [ ] Cockpit panel from Phase D extended with a "anonymous sessions on authenticated surface" counter.

---

### PHASE ORB-2+3 — Close/reopen continuity + cadence (one combined PR)

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start.
**Estimated effort**: 2-3 days.
**Depends on**: Phase ORB-1 shipped (auth is the prerequisite for trustworthy per-user continuity).

#### 4.2.1 Goal

`_hide()` calling `_sessionStop()` clears `_transcriptHistory`, `_reconnectCount`, `conversationId`, `_preDisconnectStage`. Closing the ORB for a minute therefore looks "first-time" on reopen. `wake_cadence:last_turn_at` has a reader but no writer in the live path. Both together cause the "first-time greeting on every reopen" symptom that VTID-03172 thrash tried to fix at the prompt layer (wrong layer).

#### 4.2.2 Required schema (new Supabase table)

```sql
-- Migration: 20260530000000_VTID-XXXXX_orb_session_state.sql
CREATE TABLE IF NOT EXISTS orb_session_state (
  user_id      UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  key          TEXT NOT NULL,           -- 'continuity', 'pending_cta', 'audio_ready_ack', etc.
  value        JSONB NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS orb_session_state_expires_at_idx ON orb_session_state(expires_at);

-- TTL cleanup helper (called from a cron):
CREATE OR REPLACE FUNCTION orb_session_state_gc()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM orb_session_state WHERE expires_at < NOW();
$$;
```

#### 4.2.3 Files

- New: `supabase/migrations/20260530000000_VTID-XXXXX_orb_session_state.sql`.
- New: `services/gateway/src/services/orb/orb-session-state.ts` (typed read/write with TTL).
- `services/gateway/src/frontend/command-hub/orb-widget.js` — split `_hide` / `_disconnect` / `_reset` semantics; persist continuity via gateway round-trip on close.
- `services/gateway/src/orb/live/session/live-session-controller.ts` — read continuity on session start; write `wake_cadence:last_turn_at` on every meaningful user turn; await `recordWakeBriefEmitted`.
- `services/gateway/src/services/orb/greeting-policy.ts` — refactor to `decideGreetingPolicyAuthoritative(deps)` taking explicit inputs (no partially-init session fields).
- `services/gateway/src/services/orb/wake-cadence-signals.ts` — add the missing writer.
- `services/agents/orb-agent/session.py` (LiveKit) — honor `policy='skip'` and `'brief_resume'` decisions; don't play full greeting anyway.

#### 4.2.4 Implementation outline

Widget:
```js
VitanaOrb.hide = function () {
  // UI close, preserve short-lived continuity. Stop media, but persist:
  //   - conversationId
  //   - compact transcript summary or last N turns
  //   - last turn timestamp
  //   - last greeting timestamp
  //   - close reason: 'hide'
  void _persistContinuity({ reason: 'hide', ttl_minutes: 15 });
  _uiClose();
  _stopMedia();
};
VitanaOrb.disconnect = function (reason) {
  // Transient transport loss. Preserve reconnect context, attempt reconnect.
  void _persistContinuity({ reason, ttl_minutes: 5 });
  _attemptReconnect();
};
VitanaOrb.reset = function () {
  // Intentional forget. Logout / account switch / explicit "start over".
  void _clearContinuity();
  VitanaOrb.clearAuth();
  _stopMedia();
  _uiClose();
};
```

Backend:
```ts
// On session start, hydrate from orb_session_state:
const continuity = await orbSessionState.read(userId, 'continuity');
if (continuity && continuity.expires_at > Date.now()) {
  session.conversationId = continuity.value.conversation_id;
  session.transcriptHistory = continuity.value.transcript_history;
  session.lastTurnAt = continuity.value.last_turn_at;
  session.lastGreetingAt = continuity.value.last_greeting_at;
}

// In the greeting decision:
const policyInputs = {
  lastSessionInfo: await fetchLastSessionInfo(userId),
  cadenceSignals: await fetchWakeCadenceSignals(userId),
  authenticatedIdentity: session.identity,
  surface: resolveSurface(req),
};
const policy = decideGreetingPolicyAuthoritative(policyInputs);

// At any meaningful user turn:
await writeWakeCadence(userId, 'last_turn_at', new Date().toISOString());
```

#### 4.2.5 Acceptance

- [ ] Migration applied to staging + prod; `orb_session_state` table exists.
- [ ] Close + reopen after 60s → `skip` or `brief_resume`, never `first` (verified in OASIS events).
- [ ] Reopen within 15 min → no daily journey summary again.
- [ ] Logout → next user has zero continuity leak (verified by switching dragan1 ↔ dragan3 in a single session).
- [ ] LiveKit agent honors `skip` / `brief_resume`.

---

### PHASE ORB-4 — Audio-ready handshake

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start.
**Estimated effort**: 1 day.
**Depends on**: Phase ORB-2+3 (uses `orb_session_state` for shared ack).

#### 4.4.1 Goal

Don't waste the one important greeting before the client's audio pipeline is ready. Client emits a `audio_pipeline_ready` signal as soon as AudioContext is unlocked + output device available + player initialized. Backend delays greeting trigger until ready or 3-second fallback timeout.

#### 4.4.2 Files

- `services/gateway/src/frontend/command-hub/orb-widget.js` — emit `audio_pipeline_ready` to gateway via a new endpoint or as part of session start.
- New gateway route `POST /api/v1/orb/session/:id/audio-ready` — writes ack into `orb_session_state`.
- `services/gateway/src/orb/live/session/live-session-controller.ts` — gate greeting prompt construction on ack or 3s timeout.
- `services/agents/orb-agent/session.py` (LiveKit) — equivalent gate before publishing the greeting.

#### 4.4.3 Acceptance

- [ ] If audio unlock is delayed (synthetic test), greeting waits for the ack.
- [ ] If 3-second timeout fires (no ack), greeting proceeds anyway (don't strand the session).
- [ ] Reconnect path does NOT resend a full greeting if `first_audio_ended` was recorded in `orb_session_state` within 15 min.

---

### PHASE ORB-5 — Autopilot CTA contract

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start.
**Estimated effort**: 2 days.
**Depends on**: Phase ORB-2+3 (uses `orb_session_state` for shared pending-CTA).

#### 4.5.1 Goal

Today the autopilot recommendation next-action source generates `CTA type='ask_permission'` with `recommendation_id` but NO `toolName` or `on_yes_tool` wired. When the user says "yes", the model has no deterministic action and either calls the wrong tool or responds "I have no access". The tool DOES exist (`activate_recommendation` in `live-tool-catalog.ts`, handler in `orb-tools-shared.ts`) but pending-CTA state isn't shared cross-transport.

#### 4.5.2 Files

- `services/gateway/src/services/assistant-continuation/providers/next-action/sources/autopilot-recommendation.ts` — attach `toolName: 'activate_recommendation'` + `payload: { id: recommendation_id }` to the CTA.
- `services/gateway/src/services/assistant-continuation/providers/next-action/index.ts` — write pending CTA into `orb_session_state` with 5-min TTL when the CTA is selected.
- `services/gateway/src/services/orb-tools-shared.ts` — extract activation logic into a shared service `activateRecommendation(id, userId, role)` called from both voice tool and REST route.
- `services/gateway/src/routes/autopilot-recommendations.ts` — REST route delegates to shared service.
- `services/gateway/src/orb/live/tools/live-tool-catalog.ts` — tool signature unchanged; ensure error returns distinguish `activated` / `already active` / `missing recommendation` / `insufficient permission` / `navigation only fallback`.
- `services/agents/orb-agent/session.py` (LiveKit) — declare `activate_recommendation` tool with identical signature; read pending CTA from `orb_session_state`.

#### 4.5.3 Acceptance

- [ ] Every spoken permission offer carries an executable pending CTA.
- [ ] "Yes" after autopilot offer invokes `activate_recommendation` with correct ID.
- [ ] Unauthorized user gets the truthful fallback (not "I have no access").
- [ ] Verified on BOTH Vertex AND LiveKit.

---

### PHASE ORB-6 — E2E regression + observability

**Status**: pending
**Stream**: Recovery
**VTID**: allocate at start.
**Estimated effort**: 3 days. Can run parallel to ORB-5.

#### 4.6.1 Test suites

1. **Widget unit/regression** (`services/gateway/test/frontend/`):
   - `orb-widget-audio-playback.test.ts` — exists, keep green.
   - `orb-widget-stop-regression.mjs` — exists, keep green.
   - new `orb-widget-continuity.test.ts` — close+reopen preserves continuity within 15 min TTL; reset clears it.
   - new `orb-widget-auth-reactive.test.ts` — init with empty token then `setAuth()` starts authenticated session.

2. **Backend unit** (`services/gateway/test/`):
   - new `greeting-policy-authoritative.test.ts` — recent session → non-`first` bucket; recent greeting → suppresses daily summary; missing token on authenticated surface → refuses.
   - new `autopilot-cta-contract.test.ts` — CTA candidate produces executable, accepted CTA calls `activate_recommendation` with ID.

3. **Synthetic browser flow** (Playwright, `services/gateway/e2e/` or `vitana-v1/e2e/`):
   - Login → open ORB → receive greeting audio → close 60s → reopen → no first-time greeting → accept autopilot rec → activation succeeds.
   - Run twice: once with Vertex active, once with LiveKit canary forced on.

#### 4.6.2 Observability dashboard panels (extend Phase D cockpit)

- Anonymous sessions while shell logged in.
- Repeated daily greeting within 15 min.
- Greeting selected but no audio scheduled.
- Autopilot permission offer without executable CTA.
- Tool activation failures by reason.

#### 4.6.3 Acceptance

- [ ] All test suites green.
- [ ] Synthetic flow passes on both providers in CI.
- [ ] Dashboard panels render real data after 24h of post-deploy traffic.

---

## 5. CROSS-CUTTING

### 5.1 Shared session state (`orb_session_state`)

Used by Phases 2+3, 4, 5. Schema in §4.2.2. Read/write helper in `services/gateway/src/services/orb/orb-session-state.ts`. TTL cleanup cron daily.

### 5.2 Vertex + LiveKit parity

Every PR description states parity explicitly. When a change is Vertex-only or LiveKit-only, justify why and track the parallel work as a separate VTID. The two providers are:

- **Vertex** — gateway-driven WebSocket to Vertex Live API. Session lifecycle in `services/gateway/src/orb/live/session/`. Audio relayed PCM-over-SSE to widget.
- **LiveKit** — frontend-driven WebRTC via `livekit-client` SDK in vitana-v1. Python agent at `services/agents/orb-agent/session.py` joins the room and publishes audio track. Gateway routes at `/api/v1/orb/livekit/*` handle token issuance + provider selection.

### 5.3 Rollback playbook

For each merged PR:

1. **Single revert** — `gh pr create` from `git revert <sha>`. If CI green, merge + redeploy in ~15 min.
2. **Diagnose before reverting more than 1** — log dive, DB introspection, compare working vs broken account.
3. **Data-side bugs aren't fixed by reverting code** — see the 2026-05-29 Dragan1 incident where two reverts were misdiagnosis.

### 5.4 Communication protocol (how to update this plan)

- Status updates in the state-machine table.
- Run logs under each phase.
- New observations / blockers in a `Notes` subsection at the end of each phase.
- For STOP-AND-ASK gates (currently only Phase C), open a design PR with explicit ask + tag the founder; wait for explicit approval.

### 5.5 STOP-AND-ASK conditions (any phase)

- A PR's CI fails for an unexplained reason that isn't a flake on re-run.
- A deploy succeeds but smoke tests fail (`/alive` 200 but `?v=` mismatch, or curl returns `text/html`).
- A DB migration would touch more than one user's data (the dragan1 prune was one-user, fine; a fanout prune would not be).
- An architectural change you can't justify against this plan's principles.
- More than 2 reverts in a 24-hour window — STOP, write up the situation, escalate.

### 5.6 What "done" means

A phase is `verified` only when:

1. PR merged + EXEC-DEPLOY SUCCESS + `/alive` 200.
2. All acceptance checks in the phase section ticked.
3. Real-user smoke on at least one community account passed.
4. No new error events in OASIS for at least 1 hour post-deploy.
5. Status updated in the state-machine table.

---

## 6. GLOSSARY

- **Wake brief** — the first turn Vitana speaks when a user opens the ORB. Composed by continuation providers (`new-day-return`, `voice-wake-brief`, `feature-discovery-teacher`).
- **Continuation provider** — pluggable producer that returns a candidate `userFacingLine` for a surface event (`orb_wake`, `orb_turn_end`). Ranked by priority; highest wins.
- **Surface** — community / developer / admin. Determines persona overlay.
- **Persona overlay** — `dev_orb` config fields applied on top of `voice_live` when surface = `command-hub`.
- **Wake-brief override block** — the structured prompt block prepended to `system_instruction` to make Vitana speak a specific line first. Sentinel: `<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>`.
- **Bootstrap context** — accumulated memory + facts + recent activity rendered into the system_instruction by `vitana-brain.ts`.
- **EXEC-DEPLOY** — the canonical Cloud Run deploy workflow. Dispatched by Auto Deploy on push to main IFF the commit message has a VTID/BOOTSTRAP marker.
- **Path Ownership Guard** — CI check enforcing the DEV-COMHU marker on Command Hub frontend edits.

---

## 7. EXTENSION POINTS

The agent works phases sequentially. While the agent is on Phase A, the human owner (or another instance of me) may extend the spec for Phases B–6. Any extension:

- Lands as a PR to this file. CI is the same (markdown lint at most).
- Increments the "Updated" header at the top.
- Adds a Run log entry: `YYYY-MM-DD HH:MM UTC — extended Phase X spec (sections Y.Z added)`.

End of plan.
