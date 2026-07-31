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
    expect(out).toContain('Hi Dragan');
  });

  it('instructs the model not to use the Vitana ID handle as a form of address', () => {
    const out = build('Dragan');
    expect(out).toContain('Do NOT use their Vitana ID handle');
    expect(out).toContain('never for greetings or general');
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
