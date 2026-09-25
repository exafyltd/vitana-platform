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
  createPendingConflictStore,
  dropPlaceholderYear,
  uuidOrNull,
  findRelatedFact,
  keyTokens,
  type RememberFactDeps,
} from '../../src/services/memory/remember-fact-tool';

function deps(over: Partial<RememberFactDeps> = {}): RememberFactDeps & { write: jest.Mock } {
  return {
    readCurrentFact: jest.fn(async () => null),
    readProfileValue: jest.fn(async () => null),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    pendingConflicts: createPendingConflictStore(),
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

  it('after the conflict was reported and the member confirms, confirm_replace writes the new value', async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: '4. November 1997', extracted_at: 'x' })) });
    const first = await runRememberFact({ ...base, fact_key: 'spouse_birthday', fact_value: '4. November 1999' }, d);
    expect(first.status).toBe('conflict');
    const r = await runRememberFact({ ...base, fact_key: 'spouse_birthday', fact_value: '4. November 1999', confirm_replace: true }, d);
    expect(r.status).toBe('saved');
    expect(r.replaced_value).toBe('4. November 1997');
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it('confirm_replace without a reported conflict is still a conflict: the member is asked first', async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: '5. Mai', extracted_at: 'x' })) });
    const r = await runRememberFact({ ...base, fact_key: 'brother_paul_birthday', fact_value: '7. Mai', about: 'other', confirm_replace: true }, d);
    expect(r.status).toBe('conflict');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a confirmation older than the window is not honoured', async () => {
    let t = 0;
    const d = deps({
      readCurrentFact: jest.fn(async () => ({ fact_value: '5. Mai', extracted_at: 'x' })),
      pendingConflicts: createPendingConflictStore(1000),
      now: () => t,
    });
    await runRememberFact({ ...base, fact_key: 'k', fact_value: '7. Mai' }, d);
    t = 5000;
    const r = await runRememberFact({ ...base, fact_key: 'k', fact_value: '7. Mai', confirm_replace: true }, d);
    expect(r.status).toBe('conflict');
  });

  it('a voice session id is never sent as the uuid thread id (live staging: every write failed)', async () => {
    const d = deps();
    await runRememberFact({ ...base, fact_key: 'pet_name', fact_value: 'Bello', thread_id: 'live-d6c34724-16d5-4463-8072-05f971577708' }, d);
    expect(d.write.mock.calls[0][0].thread_id).toBeNull();
    const uuid = 'd6c34724-16d5-4463-8072-05f971577708';
    await runRememberFact({ ...base, fact_key: 'pet_type', fact_value: 'Hund', thread_id: uuid }, d);
    expect(d.write.mock.calls[1][0].thread_id).toBe(uuid);
    expect(uuidOrNull('live-x')).toBeNull();
  });

  it('a year the member never said (1900) is stored as day and month only', async () => {
    expect(dropPlaceholderYear('1900-05-05')).toBe('--05-05');
    expect(dropPlaceholderYear('1969-09-09')).toBe('1969-09-09');
    const d = deps();
    const r = await runRememberFact({ ...base, fact_key: 'brother_paul_birthday', fact_value: '1900-05-05', about: 'other' }, d);
    expect(r.status).toBe('saved');
    expect(d.write.mock.calls[0][0].fact_value).toBe('--05-05');
    expect(valuesMatch('--05-05', '5. Mai')).toBe(true);
  });

  it('a failed write is reported as failed, never as saved', async () => {
    const d = deps({ write: jest.fn(async () => ({ ok: false, error: 'boom' })) as any });
    const r = await runRememberFact({ ...base, fact_key: 'pet_name', fact_value: 'Bello' }, d);
    expect(r.status).toBe('failed');
    expect(r.instruction).toMatch(/do not say it was saved/);
  });
});

describe('VTID-04588 — the same thing stored under another key', () => {
  const stored = [
    { fact_key: 'paul_birthday', fact_value: 'May 5', extracted_at: '2026-09-25T20:28:50Z' },
    { fact_key: 'sibling_name', fact_value: 'Paul', extracted_at: '2026-09-25T20:28:50Z' },
    { fact_key: 'spouse_birthday', fact_value: '4. November 1999', extracted_at: '2026-09-20T10:00:00Z' },
  ];

  it('maps German and English words to one set', () => {
    expect([...keyTokens('Bruder Paul Geburtstag')].sort()).toEqual(['birthday', 'brother', 'paul']);
    expect([...keyTokens('birthday_of_my_wife')].sort()).toEqual(['birthday', 'spouse']);
  });

  it('finds the related fact, and never on a single shared word', () => {
    expect(findRelatedFact('bruder_paul_geburtstag', stored)?.fact_key).toBe('paul_birthday');
    expect(findRelatedFact('geburtstag_meiner_frau', stored)?.fact_key).toBe('spouse_birthday');
    expect(findRelatedFact('birthday', stored)).toBeNull();
    expect(findRelatedFact('lena_birthday', stored)).toBeNull();
  });

  it('a different value under another key is a conflict on the stored key (the live staging case)', async () => {
    const d = deps({ listCurrentFacts: jest.fn(async () => stored) });
    const r = await runRememberFact({ ...base, fact_key: 'Bruder Paul Geburtstag', fact_value: '1900-05-07', about: 'other' }, d);
    expect(r.status).toBe('conflict');
    expect(r.fact_key).toBe('paul_birthday');
    expect(r.stored_value).toBe('May 5');
    expect(d.write).not.toHaveBeenCalled();

    const ok = await runRememberFact({ ...base, fact_key: 'Bruder Paul Geburtstag', fact_value: '1900-05-07', about: 'other', confirm_replace: true }, d);
    expect(ok.status).toBe('saved');
    expect(d.write.mock.calls[0][0].fact_key).toBe('paul_birthday');
    expect(d.write.mock.calls[0][0].fact_value).toBe('--05-07');
  });

  it('the same value under another key is already known', async () => {
    const d = deps({ listCurrentFacts: jest.fn(async () => stored) });
    const r = await runRememberFact({ ...base, fact_key: 'wife_birthday', fact_value: 'November 4, 1999', about: 'other' }, d);
    expect(r.status).toBe('already_known');
    expect(d.write).not.toHaveBeenCalled();
  });
});
