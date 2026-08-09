/**
 * VTID-03447: AUTHORITATIVE USER NAME header.
 *
 * Root cause: buildLiveSystemInstruction() pins a loud, structural
 * "=== AUTHORITATIVE USER VITANA ID ===" header near the top of the prompt,
 * but never gave the user's real name equivalent prominence — it only ever
 * appeared buried inside memory-fact bullet lists deep in bootstrapContext.
 * Gemini reliably infers "use the name fact for address" anyway; Nova Sonic
 * does not, and falls back to the one loud, explicit identifier it has — the
 * handle — greeting the user by their @vitana_id (e.g. "Dragan3") instead of
 * their first name.
 *
 * These tests lock: the header renders with the resolved name and an
 * explicit "don't use the handle for address" instruction when
 * resolvedFirstName is supplied, and is absent when it isn't (matching the
 * existing vitanaId null-branch pattern).
 *
 * VTID-03475 (regression): the header's FIRST version also said "Greet them
 * and address them by this name — 'Hi <Name>', 'Hallo <Name>'". That is an
 * unconditional greeting instruction carrying two literal templates, pinned
 * at the top of the prompt, and it outranked the per-turn opening directive
 * (whose short-gap/reconnect rungs say "Do NOT say Hello or the user's
 * name"), the RECONNECT SILENCE RULE, and the FLEXIBLE WORDING rule. Live
 * symptom: an identical "Guten Tag <Name>! Ich freue mich, dich bei
 * Vitanaland zu sehen." on EVERY ORB open, three times inside one minute.
 * The header is now a lookup ("which word to use IF you address them"), not
 * a directive to greet — the tests below lock that it stays one.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

const H_NAME = '=== AUTHORITATIVE USER NAME ===';

function build(resolvedFirstName?: string | null): string {
  return buildLiveSystemInstruction(
    'en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@dragan3',
    undefined, // omitGreetingPolicy
    undefined, // surface
    true,      // omitToolsProse
    resolvedFirstName,
  );
}

describe('VTID-03447: AUTHORITATIVE USER NAME header', () => {
  it('renders the header with the resolved first name when supplied', () => {
    const out = build('Dragan');
    expect(out).toContain(H_NAME);
    expect(out).toContain("The user's first name is: Dragan");
  });

  it('instructs the model not to use the Vitana ID handle as a form of address', () => {
    const out = build('Dragan');
    expect(out).toContain('Do NOT use their Vitana ID handle');
    expect(out).toContain('never for greetings or general');
  });

  // VTID-03475 — the regression that made ORB say the same "Guten Tag
  // <Name>!" on every single open, including reconnects seconds apart.
  describe('VTID-03475: the header is a lookup, never a greeting instruction', () => {
    /** The header block only, so assertions can't be satisfied (or broken) by
     *  unrelated prompt text elsewhere in the instruction. */
    function nameHeaderBlock(name: string): string {
      const out = build(name);
      const start = out.indexOf(H_NAME);
      expect(start).toBeGreaterThan(-1);
      const end = out.indexOf('================================', start + H_NAME.length);
      expect(end).toBeGreaterThan(start);
      return out.slice(start, end);
    }

    it('ships no greeting exemplar the model can parrot verbatim', () => {
      const block = nameHeaderBlock('Dragan');
      expect(block).not.toMatch(/"?\b(Hi|Hallo|Hello|Guten Tag)\b\s+Dragan/i);
    });

    it('does not tell the model to greet the user', () => {
      const block = nameHeaderBlock('Dragan');
      // No imperative "Greet them ..." / "Address them by ..." directive.
      expect(block).not.toMatch(/^\s*Greet them/im);
      expect(block).not.toMatch(/Greet them and address them/i);
      expect(block).toMatch(/LOOKUP, not an instruction to greet/i);
    });

    it('subordinates itself to the per-turn opening directive and greeting rules', () => {
      const block = nameHeaderBlock('Dragan');
      expect(block).toMatch(/opening directive/i);
      expect(block).toMatch(/OBEY IT/);
      expect(block).toMatch(/never overrides it/i);
      expect(block).toMatch(/Never open two conversations with the same\s+sentence/i);
    });
  });

  it('is absent when no resolved first name is available (null)', () => {
    const out = build(null);
    expect(out).not.toContain(H_NAME);
  });

  it('is absent when no resolved first name is available (undefined)', () => {
    const out = build(undefined);
    expect(out).not.toContain(H_NAME);
  });

  it('is absent for an empty/whitespace-only name', () => {
    const out = build('   ');
    expect(out).not.toContain(H_NAME);
  });

  it('coexists with the AUTHORITATIVE USER VITANA ID header without conflict', () => {
    const out = build('Dragan');
    const vitanaIdIdx = out.indexOf('=== AUTHORITATIVE USER VITANA ID ===');
    const nameIdx = out.indexOf(H_NAME);
    expect(vitanaIdIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(-1);
    // Name header is pinned immediately after the Vitana ID header so both
    // carry the same structural prominence near the top of the prompt.
    expect(nameIdx).toBeGreaterThan(vitanaIdIdx);
  });
});
