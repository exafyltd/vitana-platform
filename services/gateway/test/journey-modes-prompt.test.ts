/**
 * NAV_GUIDED_JOURNEY — the "My Journey has two views" knowledge block teaches
 * Vitana the Guided/Einführung vs Full/Vollversion distinction so it can EXPLAIN
 * it (not just switch modes). These assert the block carries the right facts in
 * both languages.
 */
import { buildJourneyModesSection } from '../src/orb/live/instruction/journey-modes-prompt';

describe('buildJourneyModesSection', () => {
  test('EN block names both views + the German toggle labels + the explain directive', () => {
    const s = buildJourneyModesSection('en');
    expect(s).toMatch(/GUIDED JOURNEY/);
    expect(s).toMatch(/FULL APP/);
    expect(s).toMatch(/Einführung/);
    expect(s).toMatch(/Vollversion/);
    expect(s).toMatch(/same journey/i);          // it's one journey, two views
    expect(s).toMatch(/NEVER say you don't know/i);
  });

  test('DE block is German and carries the same facts', () => {
    const s = buildJourneyModesSection('de');
    expect(s).toMatch(/GEFÜHRTE JOURNEY/);
    expect(s).toMatch(/VOLLVERSION/);
    expect(s).toMatch(/Einführung/);
    expect(s).toMatch(/dieselbe Journey/i);
    expect(s).toMatch(/NIEMALS/);
    // no obviously English instruction text leaking into the DE block
    expect(s).not.toMatch(/the difference between/i);
  });

  test('de-DE / de-AT region tags still get the German block', () => {
    expect(buildJourneyModesSection('de-DE')).toMatch(/GEFÜHRTE JOURNEY/);
    expect(buildJourneyModesSection('de-AT')).toMatch(/GEFÜHRTE JOURNEY/);
  });
});
