/**
 * VTID-04653 — the fixed voice rules are stated once.
 *
 * Every voice session sends the same fixed rules before the member's own
 * context. Several were stated two or three times (the how-to vs. hand-off
 * rule, the consent step, the silent swap-back, "vary your phrasing", the
 * where-am-I tool rule), and the identity lock sent to Vertex still carried
 * the persona denial list Nova's content filter rejects. This suite pins the
 * de-duplicated shape and a size ceiling so the rules cannot quietly grow back.
 */
import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';
import { buildPersonaBehavioralRule } from '../../../../src/routes/orb-live';
import { sanitizeInstructionForNova } from '../../../../src/orb/live/upstream/nova-instruction-sanitizer';

function instruction(): string {
  return buildLiveSystemInstruction(
    'en', 'friendly, calm, empathetic', buildPersonaBehavioralRule('vitana'), 'community',
    undefined, undefined, false, null, '/home', [], undefined, '@vet180', false, undefined, true, 'Alex',
  );
}

const count = (text: string, needle: string | RegExp): number =>
  typeof needle === 'string' ? text.split(needle).length - 1 : (text.match(needle) || []).length;

describe('VTID-04653 fixed voice rules, stated once', () => {
  let text = '';
  beforeAll(() => {
    process.env.NAV_V2_ENABLED = 'true'; // the navigator production runs
    text = instruction();
  });
  afterAll(() => {
    delete process.env.NAV_V2_ENABLED;
  });

  it('keeps the how-to vs. hand-off rule in TOOLS, with one short copy in the persona block', () => {
    expect(count(text, 'HOW-TO questions only')).toBe(1);
    expect(count(text, 'BROKEN STATE IS A HAND-OFF')).toBe(1);
    expect(text).not.toContain('Knowledge Hub has 92 chapters');
  });

  it('drops the separate consent block; the one-short-confirmation rule stays in TOOLS', () => {
    expect(text).not.toContain('[VITANA — explicit consent before transfer]');
    expect(text).toMatch(/Confirm once, in your own words/);
  });

  it('states the silent swap-back in TOOLS and once more as the persona marker, never three times', () => {
    expect(count(text, /stay silent until the user speaks/g)).toBeLessThanOrEqual(2);
    expect(text).not.toContain('those are the loop trigger');
  });

  it('keeps "never ask what they want" in RULE 0 only, not repeated in TONE RULES', () => {
    const tone = text.slice(text.indexOf('## TONE RULES'), text.indexOf('## JOURNEY AWARENESS'));
    expect(tone).not.toMatch(/how can I help|wie kann ich dir helfen/i);
    expect(text).toMatch(/Wie kann ich dir helfen\?/); // RULE 0's banned list is intact
  });

  it('describes the where-am-I tool in the navigator and points at it from JOURNEY AWARENESS in one sentence', () => {
    const journey = text.slice(text.indexOf('## JOURNEY AWARENESS'));
    const journeyBlock = journey.slice(0, journey.indexOf('\n\n'));
    expect(journeyBlock).toContain('get_current_screen');
    expect(journeyBlock.length).toBeLessThan(600);
  });

  it('sends the Nova-safe identity lock to every provider (the sanitizer changes nothing)', () => {
    expect(text).not.toContain('You NEVER:');
    expect(sanitizeInstructionForNova(text).text).toBe(text);
  });

  it('keeps the specialists (Devon) on their full behavioural block', () => {
    const devon = buildPersonaBehavioralRule('devon');
    expect(devon).toContain("full ticket history, all teammates' tickets included");
    expect(devon).toContain('Examples below are GUIDANCE, not scripts');
  });

  it('stays under the measured size ceiling (member, community, en, navigator v2)', () => {
    // Measured 2026-09-26 on this exact call: 26,336 bytes before VTID-04653,
    // 18,932 after. Raise the ceiling only with a measured reason.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(19_500);
  });
});
