/**
 * VTID-04748: "lösch" requests from production live-11ec418b (2026-09-29).
 * The member asked twice to delete the dog's name; Vitana said it was deleted
 * and nothing was: the forget intent required a memory word next to "lösch",
 * and "Hundes"/"Namen" were unknown key words, so no stored fact matched.
 */
import { matchFactsToForget } from '../../../src/services/memory/forget-fact';
import { detectForgetIntent, detectLooseForgetIntent } from '../../../src/services/memory/memory-intent';

const FACTS = [
  { fact_key: 'hunde_name', fact_value: 'Bello' },
  { fact_key: 'user_pet_name', fact_value: 'Bello' },
  { fact_key: 'user_company', fact_value: 'Exafile Limited' },
  { fact_key: 'spouse_name', fact_value: 'Maria Maksina' },
] as any;

const LIVE_1 = 'nein ich möchte dass du den namen von meinem hund löscht weil das war nämlich nur ein test ich habe gar keinen hund lösche das bitte';
const LIVE_2 = 'nein quatsch ich möchte dass du den namen meines hundes löscht komplett aus dem speicher weil ich habe gar keinen hund';

describe('VTID-04748: löschen forgets the stored fact', () => {
  it.each([LIVE_1, LIVE_2])('the live request is a (loose) forget request: %s', (t) => {
    expect(detectLooseForgetIntent(t)).toBe(true);
  });

  it.each([LIVE_1, LIVE_2])('it matches both keys that hold the dog\'s name, not ambiguous: %s', (t) => {
    const r = matchFactsToForget(t, FACTS);
    expect(r.ambiguous).toBe(false);
    expect(r.matches.map((m: any) => m.fact_key).sort()).toEqual(['hunde_name', 'user_pet_name']);
  });

  it('two different values under matching keys are still ambiguous', () => {
    const r = matchFactsToForget('lösche den namen meines hundes', [
      { fact_key: 'dog_name', fact_value: 'Bello' }, { fact_key: 'user_pet_name', fact_value: 'Minka' },
    ] as any);
    expect(r.ambiguous).toBe(true);
  });

  it('"vergiss das nicht" is never a forget request', () => {
    expect(detectLooseForgetIntent('vergiss das nicht, lösch nichts')).toBe(false);
  });

  it('the strict intent is unchanged for plain "lösche den Termin"', () => {
    expect(detectForgetIntent('lösche den Termin morgen')).toBe(false);
    expect(detectLooseForgetIntent('lösche den Termin morgen')).toBe(true);
    // loose + nothing stored matches → the backstop stays silent (hook test)
    expect(matchFactsToForget('lösche den Termin morgen', FACTS).matches).toEqual([]);
  });
});
