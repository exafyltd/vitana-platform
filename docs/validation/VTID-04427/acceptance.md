# VTID-04427 — Conversation rebuild WS-3.2: the live advisor (built, inert)

This is Plan v1 (Conversation Intelligence Rebuild), Phase 3, workstream WS-3.2. It ships in PR #3614 as a companion to VTID-04339.

## Why

Nova 2 Sonic cannot take new information mid-stream except through a tool, and whatever a tool fetches adds directly to the user's wait (WS-3.1, VTID-04424, measured). The brain needs a way to give live guidance while the conversation runs without costing any audio latency. So:

- the advisor runs off the audio path, after a user turn;
- it writes a short note into the session;
- the `get_guidance` tool only reads that note, from memory, and returns at once.

## Change

- **`services/conversation/live-advisor.ts`** — the advisor itself.
  - **Input:** the last 8 turns (400 characters each), the current screen, the brain's speakable next-step leads (WS-2.3) and the declared tool names.
  - **Output:** JSON with a note, suggested tools and a confidence value. The note is an instruction to the model, in English — never a sentence for it to say (NEVER-rule 41). A note that asks the model to recite text is dropped.
  - **Suggested tools** are limited to tools actually declared for this session.
  - **Limits:** 1.5 s timeout, 20 calls per session, $0.05 per session, turns under 4 words and small talk skipped, one pass at a time, 300 output tokens.
  - **On failure** the previous note stays in place, and nothing is thrown.
- **`orb/live/session/live-advisor-hook.ts`** — where the advisor meets the session.
  - `triggerLiveAdvisor` is called after both places where a user turn is recorded (`upstream-message-handler.ts`) and is never awaited.
  - It skips anonymous sessions.
  - The next-step lookup is capped at 300 ms.
  - The model call goes through `callViaRouter('advisor', …)`, costed with `turnUsageFields`.
  - `answerGetGuidance` serves a note only while it is fresh (2 turns).
- **`routes/orb-live.ts`**
  - `get_guidance` is declared only for signed-in sessions while the advisor is active.
  - It is answered first in `executeLiveApiTool`.
  - The budget keeps it (it is in `FLAG_GATED_PRIORITY_TOOLS`, skipped when absent).
- **Observability.**
  - `orb.live.diag` stages `advisor_note` (latency, cost, tokens, note length, suggested tools, turn), `advisor_skipped` (reason) and `guidance_read` (fresh, age).
  - The brain inspector sums these into an `advisor` block: counts and cost only, never the note text.
  - The Command Hub shows a Live advisor tile (`?v=` bumped).

## Inert until the owner decides

`isLiveAdvisorActive()` is true only when **both** of these hold:

- the `advisor` stage is in `VALID_STAGES`;
- `ORB_LIVE_ADVISOR_ENABLED` is exactly `true`.

This change does **not** add the stage. Adding it is the owner's approval item in plan v1: `VALID_STAGES`, the safe default and a routing-policy row on Bedrock. Until then:

- no advisor call is made;
- `get_guidance` is not declared;
- the tile reads "not running".

The flag is not pinned on either stack.

**Also the owner's call:** what the advisor may see beyond the turns, the screen and the speakable leads. Memory and health data are deliberately out of scope.

## Acceptance

AC-1: Inert by default. The `advisor` stage is not in `VALID_STAGES`. The advisor needs the approved stage and the exact flag. No model call is made and no state is created while inactive.
TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-2: Only meaningful turns are advised, and the prompt is bounded: 8 turns of 400 characters, the screen, the leads, the tools and the language.
TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-3: The output is intent only. A recitation directive is dropped, suggested tools are limited to the declared ones, and the note is bounded.
TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-4: Cost and latency limits hold:
- call cap and cost cap per session;
- 1.5 s timeout that keeps the previous note;
- one pass at a time;
- failures, throws and bad output are recorded and never thrown.

TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-5: `get_guidance` returns at once. It serves only a fresh note (2 turns), framed as guidance rather than text to read out, and emits `guidance_read`.
TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-6: Wiring:
- declared only for signed-in sessions while active;
- answered before normal dispatch;
- triggered after both user-turn sites and never awaited;
- no Google or direct Anthropic provider named.

TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-7: The brain inspector sums notes, reads, cost, skips and suggested tools, never the note text. The Command Hub shows a Live advisor tile, verified at 1400×900 and 390×844 (`outputs/`).
TEST: services/gateway/test/services/conversation/vtid-04427-live-advisor.test.ts

AC-8 (after the owner approves the stage, on staging): a signed-in session shows `advisor_note` diags and `get_guidance` calls. The session's first-audio-after-turn times are unchanged against the prior week's p50/p90.
BLOCKED: needs the owner's `advisor` stage decision; staging ECS cannot place tasks (AWS account block).
