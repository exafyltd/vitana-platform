import { buildFirstTimeWelcomeLine } from '../../../src/orb/instruction/greeting-pools';

// A brand-new user must hear a real onboarding welcome — NEVER a returning-user
// "welcome back" line (the bug: first-timer heard "Schön, dass du wieder da bist").
describe('buildFirstTimeWelcomeLine — first-time onboarding welcome', () => {
  const RETURNING_MARKERS = /welcome back|wieder (da|hier)|zurück|left off|weitermachen|de nuevo|поново|wieder zu hören/i;

  it.each(['de', 'en', 'es', 'sr'])('localizes %s and never uses returning-user framing', (lang) => {
    const line = buildFirstTimeWelcomeLine(lang, 'Malika');
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toMatch(RETURNING_MARKERS);
    expect(line).toContain('Malika'); // greets by name
    expect(line).toMatch(/Vitana|Витана/); // introduces herself
  });

  it('DE introduces Vitana, frames the journey, and offers the first session', () => {
    const line = buildFirstTimeWelcomeLine('de', 'Malika');
    expect(line).toMatch(/Vitana/);
    expect(line).toMatch(/Reise/);            // the guided journey
    expect(line).toMatch(/erste[n]? Session/); // offers session one
    expect(line).not.toMatch(/wieder|zurück/i); // not "welcome back"
  });

  it('falls back to EN for unsupported languages (still a first-time welcome, not "welcome back")', () => {
    const line = buildFirstTimeWelcomeLine('fr', null);
    expect(line).toMatch(/Welcome to Maxina/);
    expect(line).not.toMatch(RETURNING_MARKERS);
  });

  it('omits the name cleanly when none is known', () => {
    const line = buildFirstTimeWelcomeLine('de', null);
    expect(line.startsWith('Hallo, ich bin Vitana')).toBe(true);
  });
});
