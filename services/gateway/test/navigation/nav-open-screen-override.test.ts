/**
 * VTID-04607 — fixes the voice redirect suite found in the live Nova run:
 *   1. the open-screen override sits next to the end-conversation override,
 *      only with NAV_V2_ENABLED and only on member surfaces;
 *   2. the member's own words are resolved before the model's shortened
 *      question, and a bare "yes" falls back to the question.
 */
import { buildLiveSystemInstruction, OPEN_SCREEN_OVERRIDE } from '../../src/orb/live/instruction/live-system-instruction';
import { buildPersonaBehavioralRule } from '../../src/routes/orb-live';
import { memberWordsFor } from '../../src/navigation/nav-dispatch';

function instruction(): string {
  return buildLiveSystemInstruction(
    'en', 'friendly, calm, empathetic', buildPersonaBehavioralRule('vitana'), 'community',
    undefined, undefined, false, null, '/home', [], undefined, null, false, undefined, true,
  );
}

describe('VTID-04607 open-screen override', () => {
  afterEach(() => {
    delete process.env.NAV_V2_ENABLED;
  });

  it('follows the end-conversation override when the registry navigator is on', () => {
    process.env.NAV_V2_ENABLED = 'true';
    const text = instruction();
    const end = text.indexOf('ENDING THE CONVERSATION — OVERRIDES RULE 0');
    const open = text.indexOf(OPEN_SCREEN_OVERRIDE);
    expect(end).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(end);
    expect(open).toBeLessThan(text.indexOf('VITANA NAVIGATOR'));
  });

  it('is absent while the registry navigator is off', () => {
    expect(instruction()).not.toContain('OPENING A SCREEN — OVERRIDES RULE 0');
  });

  it('names the tool, the intent and the member-words rule, worded positively', () => {
    expect(OPEN_SCREEN_OVERRIDE).toContain('navigate');
    expect(OPEN_SCREEN_OVERRIDE).toContain('intent "open"');
    expect(OPEN_SCREEN_OVERRIDE).toContain('whole request as they said it');
    expect(OPEN_SCREEN_OVERRIDE).not.toMatch(/\bDo NOT\b|\bNEVER\b/);
  });
});

describe('VTID-04607 member words', () => {
  it('passes the member words when they add to the question', () => {
    expect(memberWordsFor('wallet', 'Pop up my wallet quickly, I just want a quick look')).toBe('Pop up my wallet quickly, I just want a quick look');
  });

  it('adds nothing when they are the question, empty or too short', () => {
    expect(memberWordsFor('Open my inbox', 'open my inbox')).toBeNull();
    expect(memberWordsFor('inbox', '')).toBeNull();
    expect(memberWordsFor('inbox', undefined)).toBeNull();
    expect(memberWordsFor('inbox', ' a ')).toBeNull();
  });

  it('keeps only the latest 300 characters of a long turn', () => {
    const w = memberWordsFor('wallet', `${'blah '.repeat(200)}open my wallet`);
    expect(w).toHaveLength(300);
    expect(w!.endsWith('open my wallet')).toBe(true);
  });
});
