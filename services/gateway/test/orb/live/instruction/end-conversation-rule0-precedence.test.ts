/**
 * VTID-03824 (follow-up) — the ENDING THE CONVERSATION instruction must
 * actually win against RULE 0, not just exist somewhere in the prompt.
 *
 * Live-reported regression, minutes after the first VTID-03824 fix reached
 * staging: a real user said (German) "I said I don't want to talk to you"
 * — about as unambiguous a stop request as exists — and Vitana replied
 * "Was möchtest du als Nächstes angehen?" ("What would you like to tackle
 * next?"), a near-exact match of RULE 0's own banned-phrase list, instead
 * of calling `end_conversation`. Confirmed via live `oasis_events`
 * (`orb.live.diag` stage=`nova_instruction_debug_dump` for the reported
 * session): the original instruction placed the stop-conversation
 * paragraph BEFORE "PROACTIVE LEADERSHIP — RULE 0 (ABSOLUTE, EVERY TURN,
 * NO EXCEPTIONS, ALL TENURES)" with far less emphasis (no ALL-CAPS header,
 * no explicit override framing) — RULE 0's much louder, later, "NO
 * EXCEPTIONS" framing plausibly won the conflict.
 *
 * Fix: moved the instruction to AFTER RULE 0 (recency), and reframed it as
 * an explicit, named exception to RULE 0 ("OVERRIDES RULE 0 (ABSOLUTE)")
 * rather than a same-weight, unrelated paragraph the model has to notice
 * conflicts with RULE 0 on its own. Also added an explicit "if they have to
 * say it twice" catch, since the live failure was specifically a REPEATED
 * stop request being ignored, not just a first one.
 *
 * This is a structural test, not proof the model will always comply (that
 * needs live re-verification) — it pins the two things code review can
 * actually verify: the override framing exists and it is positioned to
 * win (after, not before, the rule it must override), and the block hasn't
 * ballooned past a sane size (VTID-03795/03787 measured real Nova content-
 * filter blocks once a session instruction crossed ~32-33KB).
 */

import { buildLiveSystemInstruction } from '../../../../src/routes/orb-live';
import { PERSONA_DAY_180_RECONNECT } from '../characterization/personas';

describe('VTID-03824 follow-up: ENDING THE CONVERSATION must override RULE 0, not just coexist with it', () => {
  const instruction = buildLiveSystemInstruction(
    PERSONA_DAY_180_RECONNECT.lang,
    PERSONA_DAY_180_RECONNECT.voiceStyle,
    PERSONA_DAY_180_RECONNECT.bootstrapContext,
    PERSONA_DAY_180_RECONNECT.activeRole,
    PERSONA_DAY_180_RECONNECT.conversationSummary,
    PERSONA_DAY_180_RECONNECT.conversationHistory,
    PERSONA_DAY_180_RECONNECT.isReconnect,
    PERSONA_DAY_180_RECONNECT.lastSessionInfo,
    PERSONA_DAY_180_RECONNECT.currentRoute,
    PERSONA_DAY_180_RECONNECT.recentRoutes,
    undefined,
    PERSONA_DAY_180_RECONNECT.vitanaId,
  );

  const rule0Idx = instruction.indexOf('PROACTIVE LEADERSHIP — RULE 0');
  const endingIdx = instruction.indexOf('ENDING THE CONVERSATION');

  it('both sections are present', () => {
    expect(rule0Idx).toBeGreaterThan(-1);
    expect(endingIdx).toBeGreaterThan(-1);
  });

  it('ENDING THE CONVERSATION is positioned AFTER RULE 0, not before it (the actual live regression)', () => {
    // Before this fix, the stop-conversation paragraph sat BEFORE RULE 0 —
    // a real live session then had RULE 0's much louder "NO EXCEPTIONS"
    // framing win the conflict, and the model asked a banned follow-up
    // question instead of ending the conversation.
    expect(endingIdx).toBeGreaterThan(rule0Idx);
  });

  it('explicitly frames itself as overriding / suspending RULE 0, not as an unrelated adjacent rule', () => {
    const block = instruction.slice(endingIdx, endingIdx + 900);
    expect(block).toMatch(/OVERRIDES RULE 0/);
    expect(block).toMatch(/SUSPENDED/);
  });

  it('explicitly handles the reported failure: the user having to repeat the stop request', () => {
    const block = instruction.slice(endingIdx, endingIdx + 900);
    expect(block).toMatch(/say it again/i);
    expect(block).toMatch(/first call never happened/i);
  });

  it('still instructs a brief farewell before calling end_conversation, not a hard stop with no acknowledgement', () => {
    const block = instruction.slice(endingIdx, endingIdx + 900);
    expect(block).toMatch(/farewell/i);
    expect(block).toMatch(/end_conversation/);
  });

  it('still carves out Teacher Mode / My Journey, which use their own end tools', () => {
    const block = instruction.slice(endingIdx, endingIdx + 900);
    expect(block).toMatch(/Teacher Mode/);
    expect(block).toMatch(/My Journey/);
  });

  it('the block stays reasonably concise — VTID-03795/03787 measured real Nova content-filter blocks once a session instruction crossed ~32-33KB, so this block must not silently balloon', () => {
    const nextSectionIdx = instruction.indexOf('GUIDED JOURNEY', endingIdx);
    expect(nextSectionIdx).toBeGreaterThan(endingIdx);
    const blockLength = nextSectionIdx - endingIdx;
    expect(blockLength).toBeLessThan(1100);
  });
});
