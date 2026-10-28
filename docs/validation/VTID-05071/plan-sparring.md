# Plan — Kiro keeps the thread: decisions survive a fresh session, a missed Allow is not a silent "refusal"

<!-- plan:begin -->
## Change class
standard (gateway service code, Command Hub module, two env defaults on two services; no migration, no new route, no auth change).

## Problem (verified 2026-10-11 from the run records of Operator thread 225ab6d2…)
1. Run 8997ac76 (user: "agreed", 11:10 UTC): Kiro called a shell `grep` on app.js (kind `execute`) → approval card → nobody answered within `KIRO_PERMISSION_TIMEOUT_MS` (120 s, permission-broker.ts:28) → `kiro.permission_answer {by: timeout, allow: false}` → kiro-cli ended the turn with stop_reason `refusal` → the console showed "Kiro stopped early: refusal" (kiro-console.js:813). The user never saw a card waiting and the label blamed the wrong thing.
2. Run 6b770de3 (user: "continue", 11:45, 33 min later): the Kiro session had closed on idle (`KIRO_SESSION_IDLE_MS` 15 min, kiro-turn.ts:217; runner `KIRO_RUNNER_IDLE_MS` 15 min, kiro-runner index.ts:50). The new session got the restored history block (kiro-turn.ts:117-150): every message clipped to 2,000 chars (first 500 + last ~1,500), whole block ≤ 16,000 chars. The replies that carried the agreed decision (3,040 and 8,711 chars) lost their middle. Kiro rebuilt its picture from fragments, reverted to an earlier wrong model of the screen and re-asked the user for the goal.
3. Kiro cannot search `services/gateway/src/frontend/command-hub/app.js` (2.4 MB, over the code-search limit), so it falls back to shell grep, which always needs an Allow card (point 1). The symbol index `services/gateway/specs/command-hub-symbol-index.json` (function → line) exists and is readable with the auto-allowed `@vitana/dev_read_file`.

## Changes
### A. Decisions survive a fresh session (history restore, kiro-turn.ts)
1. One uniform, larger cap (no tiering): `KIRO_HISTORY_MESSAGE_CHARS` 2,000 → 6,000, `KIRO_HISTORY_HEAD_CHARS` 500 → 1,500, `KIRO_HISTORY_TOTAL_CHARS` 16,000 → 40,000. `clipHistoryMessage` / `restoredHistoryBlock` keep their exact shape (same marker, oldest dropped first with the "N earlier message(s) omitted" line). For the incident: the 3,040-char reply is kept whole; the 8,711-char reply keeps its first 1,500 and last ~4,450 chars.
   Context budget: 40,000 chars ≈ 10K tokens. Kiro runs Claude models (the model list comes from kiro-cli; every model id the gateway handles or pins in tests is claude-sonnet-* / claude-opus-*, and the thread used `auto`) with a 200K-token window, so the restore stays ≈ 5% of it, next to the session rules (~1K) and the user's message.
2. The restored block's header gains one line: "If the thread already agreed on a decision, continue from it; do not re-ask what was agreed." This is a best-effort prompt nudge (agent instruction, not user-facing text), not a guarantee; the mechanical fix is A1 keeping the decision text.
3. Constants exported and pinned by tests; no LLM summarizer (no new Bedrock call, no new cost, nothing that can drift).

### B. Session lifetime
4. Idle close 15 → 45 min at the gateway (`KIRO_SESSION_IDLE_MS`) and 15 → 50 min at the runner (`KIRO_RUNNER_IDLE_MS`), so the gateway always closes first and stays the authority on when a session ends (same-line defaults; env still overrides). The existing session caps (3 per user, 10 global) bound the memory cost; the 15-min prompt timeout (acp-client.ts:120) is unchanged.

### C. A missed Allow is visible and honestly labelled
5. `KIRO_PERMISSION_TIMEOUT_MS` default 120 s → 600 s (still inside the 15-min prompt timeout).
6. Console (kiro-console.js): while a run is `waiting_permission`, the thread row in the sidebar shows an amber "Needs your OK" pulse (reduced-motion: static), and the browser tab title is prefixed "(!) " until answered.
7. When a run ends `refused`/`incomplete` right after a permission answered `by: timeout`, the console shows "Stopped — your approval for "<tool title, 80 chars>" timed out. [Continue]" instead of "Kiro stopped early: refusal". Continue sends the same Continue message as an interrupted run (existing behaviour). Any other refusal keeps the current label.
8. The run record already carries the evidence (permission_answer by timeout, then turn_end refusal); the label is derived client-side from those events — no schema change.

### D. Kiro stops guessing at app.js
9. `KIRO_SESSION_RULES` gains two lines (agent instructions):
   - "To find Command Hub UI code in services/gateway/src/frontend/command-hub/app.js (too large for code search), read services/gateway/specs/command-hub-symbol-index.json first (function → line), then read only those lines with dev_read_file. Do not grep app.js in a shell."
   - "Prefer the read-only @vitana tools over shell commands; a shell command needs the user's approval and stops the turn if it is not given."

## Out of scope
Raising the 15-min prompt timeout; an LLM-written thread summary; changing which tools need approval; push notifications to the phone.

## Files
- services/gateway/src/services/kiro/kiro-turn.ts (A1-A3, B4 default, D9)
- services/gateway/src/services/kiro/permission-broker.ts (C5)
- services/kiro-runner/src/index.ts (B4 runner default)
- services/gateway/src/frontend/command-hub/kiro-console.js + kiro-console.css (C6-C7) + index.html `?v=` bump (+ staging suites naming the old version) + regenerated services/gateway/specs/command-hub-symbol-index.json (generator script, `--check` in CI)
- tests: test/vtid-05018-kiro-thread-memory.test.ts (restore budget), new test for the session rules + timeout default, command-hub jest for the console label/pulse, runner vitest for the idle default; operator pipeline suite scenario: permission timeout → refused → console label + Continue.
- docs/validation/<VTID>/{plan-sparring.md, acceptance.md, commands.log, staging-tests.json}

## Tests
- Unit: a 3,040-char reply is restored whole; an 8,711-char reply keeps its first 1,500 and its end; total ≤ 40,000; oldest dropped first with the omitted line.
- Unit: permission timeout default 600 s; env override still works.
- Unit: gateway idle default 45 min < runner idle default 50 min.
- Unit: session rules contain the symbol-index line and the prefer-read-tools line.
- Command-hub jest: waiting_permission → pulse class + title prefix, cleared on answer; refusal after a timeout answer → "approval … timed out" + Continue; plain refusal → old label.
- Runner vitest: idle default 50 min.
- `npm run test:operator`, `test:support`, `test:roles` green; new operator-pipeline scenario as above.
- Staging (read-only): kiro-console.js served at the new `?v=` with the timeout label string; /command-hub/ loads it.
<!-- plan:end -->

## Planner responses — round 1
- F1 major — ACCEPTED: tiering dropped. One uniform cap: 6,000 per message (head 1,500), 40,000 total; same function shape and marker. Incident replies: 3,040 kept whole, 8,711 keeps head 1,500 + tail ~4,450.
- F2 major — ACCEPTED: budget stated in A1 — 40,000 chars ≈ 10K tokens against Claude's 200K-token window (Kiro's model ids are claude-sonnet-*/claude-opus-*; thread used `auto`), ≈ 5%.
- F3 minor — ACCEPTED: gateway idle 45 min, runner idle 50 min, so the gateway always closes first; a test pins gateway < runner.
- F4 minor — ACCEPTED: A2 now says it is a best-effort nudge; A1 is the mechanical fix.
- F5 minor — ACCEPTED: symbol-index regeneration added to Files.
- F6 minor — ACKNOWLEDGED: pre-existing; the generator's `--check` runs in CI and fails on a stale index, so the line numbers Kiro reads match the committed app.js.
- Q1: answered in F2. Q2: yes — that is the accepted design (F1). Q3: the card already has Allow and Deny, and the run has Stop (cancel); the user never has to wait the 10 minutes — the longer timeout only gives a user who stepped away time to come back.

## Round 2 (partner)
F1–F6 all closed; no new blocker or major; no questions. One note: the gateway-vs-runner idle ordering is asserted by pinning each package's numeric default in its own test suite (they are separate packages).

## Verdict
CONVERGED after 2 rounds (round 1: 0 blocker / 2 major / 4 minor — all accepted or acknowledged; round 2: all closed).

## Owner approval
APPROVED by the owner in the Claude Code session on 2026-10-11 ("yes"), plan hash 1a8b4bdc8b71a4075b2e0be8424c41fb6fce49443577fb09c007fd7c22e41c33.

## Scope addition (round 3, same partner)
C6 needs one hook line in app.js (`renderOperatorSessionsSidebar` row meta, next to the VTID-05069 PipelineTree dot): `if (window.KiroConsole && window.KiroConsole.waitingBadge) meta.appendChild(window.KiroConsole.waitingBadge(thread.id));`, with the app.js `?v=` bump and VTID-05071 on the Command Hub ownership guard. Partner verified the premises: CONVERGED, no new findings.

Sparring record: plan_sparring_sessions f9145a2f-e52e-40d7-8e7b-207115ba71e8.
