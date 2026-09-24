# VTID-04423 — Conversation rebuild WS-2.3: next-step decisions during the conversation

This is Plan v1 (Conversation Intelligence Rebuild), Phase 2, workstream WS-2.3.
It ships in PR #3614 as a companion to VTID-04339.

## Why

At session start the 13 continuation providers produce candidates. One may open the conversation (WS-2.1), and the rest were thrown away. Mid-conversation, the model had nothing to draw on for "what should I do next" beyond the health-only `get_next_best_action`.

The plan asks for two things, and pushes no new content into the conversation:

- a brain decision that can be made at the end of a turn;
- its candidates exposed through `get_next_best_action`.

Unsolicited turn-end nudges were paused in VTID-03075 because they interrupted support flows. That pause stands, and a test pins it.

## Change

### `services/conversation/turn-candidates.ts`

- **`toStoredTurnCandidates(decision)`**: the opening's returned candidates, highest priority first, at most 8.
  - Each keeps its provider, kind, key, route, the provider's line as a **lead** (at most 220 chars), and the action tool.
  - Only candidates a provider marked `safe_to_speak` are kept; `use_silently` / `suppress_sensitive` never reach the tool.
- **`decideTurnCandidates(stored, ctx, weights)`**: the mid-conversation decision.
  - It re-ranks the stored candidates for this moment with the WS-2.2 score: current screen, the user's outcomes, and what they have already heard.
  - It returns the top 3 that have a lead.
- **`renderTurnCandidatesText`**: presents the candidates as leads for the model to phrase in its own words and propose at most one (NEVER-rule 41). It is never a line to recite.
- **`readTurnCandidates`**: reads, re-ranks and renders. It never throws, and returns nothing when nothing is stored.
- **Kill switch:** `BRAIN_TURN_CANDIDATES=false`.

### Storage

- `wake-brief-wiring.ts` stores the candidates in `orb_session_state` under the new key `brain_candidates` (90-minute TTL).
- Only on a real emission, and only for a signed-in user, fire-and-forget.
- No schema change: the table has no key constraint (checked).

### Tool

- **`get_next_best_action` keeps its health answer unchanged** and appends the brain's re-ranked candidates.
  - In the text, the model sees them as leads.
  - In the result, they appear as `brain_candidates`.
- **Its description gains one line** saying so. 4 snapshots re-recorded; the diffs are exactly that line.

## Acceptance criteria

AC-1: Only returned, speakable candidates are stored, highest priority first, with their lead and action tool.
TEST: services/gateway/test/services/conversation/vtid-04423-turn-candidates.test.ts

AC-2: The turn decision re-ranks for the moment (a just-heard candidate drops below a fresh one), drops lead-less candidates and honours the limit.
TEST: services/gateway/test/services/conversation/vtid-04423-turn-candidates.test.ts

AC-3: The tool text presents leads to phrase, never a verbatim line.
TEST: services/gateway/test/services/conversation/vtid-04423-turn-candidates.test.ts

AC-4: Reading returns ranked leads, and returns nothing when nothing is stored, with the kill switch off, or on a read error.
TEST: services/gateway/test/services/conversation/vtid-04423-turn-candidates.test.ts

AC-5: The wake stores candidates only on a real emission; `get_next_best_action` appends them; the unsolicited turn-end nudge stays paused.
TEST: services/gateway/test/services/conversation/vtid-04423-turn-candidates.test.ts

AC-6: The ORB tool catalog and system-instruction snapshots differ only by the added description line.
TEST: services/gateway/test/orb/live/characterization

## Not verified live

- **Staging ECS could not place tasks at the time of writing.**
- **The first real signals:**
  - a `brain_candidates` row in `orb_session_state` after a signed-in staging session;
  - a `get_next_best_action` tool result (`orb.live.tool.executed`) carrying `brain_candidates`.
