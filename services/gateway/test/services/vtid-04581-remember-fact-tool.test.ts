/**
 * VTID-04581 — remember_fact tells the assistant, in the same turn, whether
 * the fact is a profile field, already known, in conflict, or saved.
 */
import {
  runRememberFact,
  formatRememberFactResult,
  normalizeDate,
  valuesMatch,
  resolveProfileKey,
  type RememberFactDeps,
} from '../../src/services/memory/remember-fact-tool';

function deps(over: Partial<RememberFactDeps> = {}): RememberFactDeps & { write: jest.Mock } {
  return {
    readCurrentFact: jest.fn(async () => null),
    readProfileValue: jest.fn(async () => null),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    ...over,
  } as any;
}
const base = { tenant_id: 't1', user_id: 'u1' };

describe('dates and values', () => {
  it.each([
    ['4. November 1997', '1997-11-04'],
    ['November 4th, 1997', '1997-11-04'],
    ['1997-11-04', '1997-11-04'],
    ['04.11.1997', '1997-11-04'],
    ['9. September', '--09-09'],
    ['am neunten', null],
  ])('%s -> %s', (input, out) => expect(normalizeDate(input)).toBe(out));

  it('matches the same date written differently, not a different year', () => {
    expect(valuesMatch('4. November 1997', 'November 4, 1997')).toBe(true);
    expect(valuesMatch('4. November 1997', '4. November 1999')).toBe(false);
    expect(valuesMatch('Maria Maksina', 'maria  maksina')).toBe(true);
  });
});

describe('profile fields', () => {
  it('resolves aliases for the member, never for someone else', () => {
    expect(resolveProfileKey('birthday', 'self')).toBe('user_birthday');
    expect(resolveProfileKey('user_birthday', undefined)).toBe('user_birthday');
    expect(resolveProfileKey('birthday', 'other')).toBeNull();
    expect(resolveProfileKey('spouse_birthday', 'self')).toBeNull();
  });

  it('a stated birthday is not saved; the profile value is reported', async () => {
    const d = deps({ readProfileValue: jest.fn(async () => '1969-09-09') });
    const r = await runRememberFact({ ...base, fact_key: 'user_birthday', fact_value: '9. September 1969' }, d);
    expect(r.status).toBe('profile_owned');
    expect(r.profile_value).toBe('1969-09-09');
    expect(r.instruction).toMatch(/already has exactly this value/);
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a differing birthday names the profile value and the profile as the place to change it', async () => {
    const d = deps({ readProfileValue: jest.fn(async () => '1969-09-09') });
    const r = await runRememberFact({ ...base, fact_key: 'birthday', fact_value: '10 October 1970' }, d);
    expect(r.status).toBe('profile_owned');
    expect(r.instruction).toMatch(/profile says 1969-09-09/);
    expect(r.instruction).toMatch(/offer to open it/);
  });

  it('an empty profile field says it is entered in the profile', async () => {
    const r = await runRememberFact({ ...base, fact_key: 'user_birthday', fact_value: '9 Sept 1969' }, deps());
    expect(r.status).toBe('profile_owned');
    expect(r.instruction).toMatch(/has no value yet/);
  });
});

describe('facts about the member and others', () => {
  it('saves a new fact', async () => {
    const d = deps();
    const r = await runRememberFact({ ...base, fact_key: 'Spouse Birthday', fact_value: '4 November 1997', about: 'other' }, d);
    expect(r.status).toBe('saved');
    expect(d.write).toHaveBeenCalledWith(expect.objectContaining({
      fact_key: 'spouse_birthday', fact_value: '4 November 1997', entity: 'disclosed', provenance_source: 'user_stated',
    }));
    expect(formatRememberFactResult(r)).toMatch(/^STATUS: saved\./);
  });

  it('the same value again is already_known and not rewritten', async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: '4. November 1997', extracted_at: 'x' })) });
    const r = await runRememberFact({ ...base, fact_key: 'spouse_birthday', fact_value: 'November 4, 1997' }, d);
    expect(r.status).toBe('already_known');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a different value is a conflict: nothing written, both values named, ask which is right', async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: '4. November 1997', extracted_at: 'x' })) });
    const r = await runRememberFact({ ...base, fact_key: 'spouse_birthday', fact_value: '4. November 1999' }, d);
    expect(r.status).toBe('conflict');
    expect(r.stored_value).toBe('4. November 1997');
    expect(r.instruction).toMatch(/ask which one is correct/);
    expect(r.instruction).toMatch(/confirm_replace=true/);
    expect(d.write).not.toHaveBeenCalled();
  });

  it('after the member confirms, confirm_replace writes the new value', async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: '4. November 1997', extracted_at: 'x' })) });
    const r = await runRememberFact({ ...base, fact_key: 'spouse_birthday', fact_value: '4. November 1999', confirm_replace: true }, d);
    expect(r.status).toBe('saved');
    expect(r.replaced_value).toBe('4. November 1997');
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it('a failed write is reported as failed, never as saved', async () => {
    const d = deps({ write: jest.fn(async () => ({ ok: false, error: 'boom' })) as any });
    const r = await runRememberFact({ ...base, fact_key: 'pet_name', fact_value: 'Bello' }, d);
    expect(r.status).toBe('failed');
    expect(r.instruction).toMatch(/do not say it was saved/);
  });
});
