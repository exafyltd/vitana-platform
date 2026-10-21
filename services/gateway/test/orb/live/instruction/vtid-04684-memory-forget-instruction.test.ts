/**
 * VTID-04684 / VTID-04685 — the member MEMORY line carries the two new rules.
 *
 * Live suite (staging, 2026-09-26): Vitana said the dog's name was deleted
 * without any forget running (B-FORG-01), and a hypothetical was stored as a
 * fact (B-NOISE-01). The gateway now enforces both (forget backstop, extractor
 * filter); this pins that the instruction the member's session is built with
 * tells the model the same thing, inside the MEMORY line.
 */
import { buildLiveSystemInstruction } from '../../../../src/routes/orb-live';
import { PERSONA_DAY_180_RECONNECT } from '../characterization/personas';

describe('VTID-04684/04685 MEMORY line in the member system instruction', () => {
  const p = PERSONA_DAY_180_RECONNECT;
  const instruction = buildLiveSystemInstruction(
    p.lang, p.voiceStyle, p.bootstrapContext, p.activeRole, p.conversationSummary,
    p.conversationHistory, p.isReconnect, p.lastSessionInfo, p.currentRoute, p.recentRoutes,
    undefined, p.vitanaId,
  );
  const start = instruction.indexOf('- MEMORY LOOKUP:');
  const line = start >= 0 ? instruction.slice(start, instruction.indexOf('\n', start)) : '';

  it('the member session carries the MEMORY line', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('forbids claiming "forgotten" before a forget STATUS says so', () => {
    expect(line).toMatch(/never claim it is forgotten until a forget STATUS says forgotten/);
  });

  it('says a wish or "what if" is not a fact to save', () => {
    expect(line).toMatch(/A wish or "what if" is not a fact: do not save it\./);
  });

  it('keeps the existing remember rules', () => {
    expect(line).toMatch(/call remember_fact and answer from its STATUS/);
    expect(line).toMatch(/never claim saved unless it says saved/);
  });
});
