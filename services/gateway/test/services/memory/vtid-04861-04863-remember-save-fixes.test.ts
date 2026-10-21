/**
 * VTID-04861 / VTID-04863 — what remember_fact stores and tells the model.
 * Scenarios from the live memory suite on staging e36e486 (2026-10-01).
 */
import {
  describeDifference,
  findRelatedFact,
  readableValue,
  runRememberFact,
  type RememberFactDeps,
  type StoredKeyedFact,
} from '../../../src/services/memory/remember-fact-tool';

const fact = (fact_key: string, fact_value: string, at = '2026-10-01T07:50:00Z'): StoredKeyedFact => ({
  fact_key,
  fact_value,
  extracted_at: at,
});

// Live B-DUP-01 left user_pet_name=Bello next to dog_name=bello. The build it ran
// on (e36e486) predates VTID-04766 (#3837), which relates relatives — and pets —
// by relation. These pin that the live case stays one fact on main.
describe('VTID-04861 a dog or a cat is a pet — one fact, one row (live B-DUP-01)', () => {
  it('the extractor\'s user_pet_name finds the dog_name the voice model saved', () => {
    expect(findRelatedFact('user_pet_name', [fact('dog_name', 'bello')])?.fact_key).toBe('dog_name');
  });
  it('and the other way round', () => {
    expect(findRelatedFact('dog_name', [fact('user_pet_name', 'Bello')])?.fact_key).toBe('user_pet_name');
    expect(findRelatedFact('hunde_name', [fact('user_pet_name', 'Bello')])?.fact_key).toBe('user_pet_name');
  });
  it('a dog is never a cat', () => {
    expect(findRelatedFact('dog_name', [fact('cat_name', 'Mimi')])).toBeNull();
    expect(findRelatedFact('katze_name', [fact('dog_name', 'Bello')])).toBeNull();
  });
  it('a pet fact about something else (the vet, the breed) is not the name', () => {
    expect(findRelatedFact('user_pet_name', [fact('dog_breed', 'Labrador')])).toBeNull();
    expect(findRelatedFact('dog_name', [fact('pet_vet', 'Dr. Weber')])).toBeNull();
  });
  it('an exact or ordinary related key still wins first', () => {
    expect(findRelatedFact('dog_name', [fact('user_dog_name', 'Bello'), fact('user_pet_name', 'Rex')])?.fact_key).toBe('user_dog_name');
  });

  it('remember_fact: the same dog said again is already_known, nothing written', async () => {
    const write = jest.fn();
    const deps: RememberFactDeps = {
      readCurrentFact: async () => null,
      readProfileValue: async () => null,
      write: write as any,
      listCurrentFacts: async () => [fact('user_pet_name', 'Bello')],
    };
    const r = await runRememberFact({ tenant_id: 't', user_id: 'u', fact_key: 'hunde_name', fact_value: 'bello' }, deps);
    expect(r.status).toBe('already_known');
    expect(r.fact_key).toBe('user_pet_name');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('VTID-04863 the stored date is named as stored (live B-CONF-06)', () => {
  it('an all-digit date is written out; other values stay as written', () => {
    expect(readableValue('1997-11-04')).toBe('4 November 1997');
    expect(readableValue('04.11.1997')).toBe('4 November 1997');
    expect(readableValue('--05-07')).toBe('7 May');
    expect(readableValue('May 5')).toBe('May 5');
    expect(readableValue('4. November 1999')).toBe('4. November 1999');
    expect(readableValue('Bello')).toBe('Bello');
  });
  it('names what differs', () => {
    expect(describeDifference('1997-11-04', '4. November 1999')).toMatch(/differ only in the year: the stored year is 1997, the member said 1999/);
    expect(describeDifference('5. Mai', '7. Mai')).toBe('');
    expect(describeDifference('1999-05-05', '1999-05-07')).toMatch(/same year \(1999\)/);
    expect(describeDifference('Bello', 'Rex')).toBe('');
  });
  it('the conflict instruction carries the stored year in words and the difference', async () => {
    const deps: RememberFactDeps = {
      readCurrentFact: async (_t, _u, k) => (k === 'spouse_birthday' ? { fact_value: '1997-11-04', extracted_at: null } : null),
      readProfileValue: async () => null,
      write: jest.fn() as any,
    };
    const r = await runRememberFact(
      { tenant_id: 't', user_id: 'u', fact_key: 'spouse_birthday', fact_value: '4. November 1999', about: 'other' },
      deps,
    );
    expect(r.status).toBe('conflict');
    expect(r.stored_value).toBe('1997-11-04'); // the data is unchanged
    expect(r.instruction).toContain('"4 November 1997"');
    expect(r.instruction).toContain('"4. November 1999"');
    expect(r.instruction).toMatch(/differ only in the year: the stored year is 1997, the member said 1999/);
    expect(r.instruction).toMatch(/name both exactly as written here/);
  });
  it('already_known names the stored date in words too', async () => {
    const deps: RememberFactDeps = {
      readCurrentFact: async () => ({ fact_value: '1997-11-04', extracted_at: null }),
      readProfileValue: async () => null,
      write: jest.fn() as any,
    };
    const r = await runRememberFact({ tenant_id: 't', user_id: 'u', fact_key: 'spouse_birthday', fact_value: '1997-11-04', about: 'other' }, deps);
    expect(r.status).toBe('already_known');
    expect(r.instruction).toContain('"4 November 1997"');
  });
});
