# VTID-04534 — conversation history and member context survive the instruction budget

## Owner report (staging, 2026-09-25 08:48–08:58 UTC)

The member spoke, the microphone listened, and then Vitana disconnected
instead of answering. When Vitana came back, she did not know what had just
been said.

## Root cause

- On its own, the fixed system prompt for an authenticated `de` community
  session was about 31.5 KB, which is more than the 30,720-byte budget
  (`INSTRUCTION_TOTAL_BYTE_BUDGET`, VTID-04021).
  - About 11.5 KB of that was the Rule 0 / offer / ending / guided-journey
    block.
  - About 7.1 KB was the TOOLS / event-link block.
- When a session goes over the budget, the guard dropped whole sections, in
  this order: member context (bootstrap), then conversation history, then
  specialist.
- So a reopened session ran with no history and no memory of the member.
  The staging debug dumps show both sections replaced by the trim marker.

## Fix

1. **Shorter fixed prompt.** Rewrote the Rule 0 + guided-journey region and
   the TOOLS region. Every rule is kept, and so is every phrase the existing
   tests pin.
   - Measured on `buildLiveSystemInstruction('de','warm',…,'community')`:

     | Region | Before (bytes) | After (bytes) |
     |---|---|---|
     | Rule 0 region | 11,553 | 4,980 |
     | TOOLS region | 7,133 | 3,990 |
     | Whole prompt | 169,112 | 159,396 |

   - The whole-prompt figure is the full builder output, before the budget
     guard splits it into sections.
2. **Shrink before drop.** When a session is over budget, `enforceInstructionBudget`
   now shortens sections before it drops any:
   - Member context is repacked first with the existing priority packer
     (VTID-04393). Pinned blocks are kept. It is not cut below a 3,000-byte
     floor.
   - Then history keeps its newest turns and marks the cut. It is not cut
     below a 1,200-byte floor.
   - The old whole-section drop still runs only if the prompt is still over
     budget after both shrinks.
3. **Observability.** The `instruction_budget` diag and the Conversation hub
   aggregates report `shortened_sections` next to `trimmed_sections`.

## Deliberate contract changes

- `guided-topic-journey-scaffold-suppression.test.ts`: the byte saving from
  suppressing the journey scaffold on a guided-topic session drops from
  ≥3,000 to ≥1,000 bytes. The suppression still happens; the scaffold it
  suppresses is simply smaller now.
- The system-instruction characterization snapshots were re-recorded. The
  diff covers only the two rewritten regions.
- `instruction-budget.test.ts`: two tests now expect shortening instead of a
  whole-section drop when shortening is enough.

## Acceptance criteria

AC-1: When shortening fits the budget, member context and history are shortened, not dropped, and the result is under budget.
TEST: services/gateway/test/orb/live/instruction/vtid-04534-shrink-before-drop.test.ts

AC-2: Member context is repacked with its pinned blocks kept; history keeps its newest turns and marks the cut.
TEST: services/gateway/test/orb/live/instruction/vtid-04534-shrink-before-drop.test.ts

AC-3: History is shortened only after member context has reached its floor; when shortening is not enough, sections are dropped in the old order.
TEST: services/gateway/test/orb/live/instruction/vtid-04534-shrink-before-drop.test.ts

AC-4: The rewritten Rule 0 region stays under 5,500 bytes and the TOOLS region under 4,500 bytes. All rule wording pinned by existing tests is kept.
TEST: services/gateway/test/orb/live/instruction/vtid-04534-shrink-before-drop.test.ts
TEST: services/gateway/test/orb/live/characterization/system-instruction.characterization.test.ts

AC-5: The budget diag and the aggregates report `shortened_sections`.
TEST: services/gateway/test/orb/live/instruction/instruction-budget.test.ts
TEST: services/gateway/test/routes/vtid-04525-conversation-hub-phase-a-routes.test.ts

## Mutation check

With the shrink loop disabled, 2 of the new tests fail.

## Not verified here

This has not been tried in a live voice session. After merge, on staging:

- New `instruction_budget` diag rows should show `shortened_sections` when
  a session is over budget, and no `bootstrap`/`history` in
  `trimmed_sections`.
- The `nova_instruction_debug_dump` of a reopened session should contain the
  conversation history block.

The Nova content-filter block on the first attempt of a reopened session,
and the retry opener that outranks the continuity candidate, is a separate,
open follow-up. This VTID does not address it.
