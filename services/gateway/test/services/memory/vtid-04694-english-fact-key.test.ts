/**
 * VTID-04694: a new fact is stored under its English key.
 *
 * Live suite B-SELF-01 (staging, 2026-09-28): "Merk dir, mein Lieblingsessen
 * ist Lasagne" was stored as `lieblingsessen = lasagne`, while the Garden's
 * facts are named in English (`user_favorite_food`).
 */
import { canonicalFactKey, runRememberFact, createPendingConflictStore } from '../../../src/services/memory/remember-fact-tool';

describe('VTID-04694 canonicalFactKey', () => {
  it.each([
    ['lieblingsessen', 'favorite_food'],
    ['mein_lieblingsessen', 'mein_favorite_food'],
    ['mutter_name', 'mother_name'],
    ['zahnarzttermin', 'dentist_appointment'],
    ['Paul Geburtstag', 'paul_birthday'],
    ['user_favorite_food', 'user_favorite_food'],
    ['work_address', 'work_address'],
    ['wife_name', 'wife_name'],
    ['colleague_marko_coffee', 'colleague_marko_coffee'],
  ])('%s → %s', (raw, want) => expect(canonicalFactKey(raw)).toBe(want));
});

function deps(stored: Array<{ fact_key: string; fact_value: string }> = []) {
  return {
    readCurrentFact: jest.fn(async (_t: string, _u: string, k: string) => {
      const f = stored.find((x) => x.fact_key === k);
      return f ? { fact_value: f.fact_value, extracted_at: 'x' } : null;
    }),
    readProfileValue: jest.fn(async () => null),
    listCurrentFacts: jest.fn(async () => stored.map((f) => ({ ...f, extracted_at: 'x' }))),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    pendingConflicts: createPendingConflictStore(),
  } as any;
}

const base = { tenant_id: 't', user_id: 'u', about: 'self' as const };

describe('VTID-04694 remember_fact', () => {
  it('stores a new German-named fact under the English key', async () => {
    const d = deps();
    const r = await runRememberFact({ ...base, fact_key: 'lieblingsessen', fact_value: 'Lasagne' }, d);
    expect(r.status).toBe('saved');
    expect(r.fact_key).toBe('favorite_food');
    expect(d.write.mock.calls[0][0]).toEqual(expect.objectContaining({ fact_key: 'favorite_food', fact_value: 'Lasagne' }));
  });

  it('keeps the key an existing fact already has', async () => {
    const d = deps([{ fact_key: 'user_favorite_food', fact_value: 'Pizza' }]);
    const r = await runRememberFact({ ...base, fact_key: 'lieblingsessen', fact_value: 'Lasagne' }, d);
    expect(r.status).toBe('conflict');
    expect(r.fact_key).toBe('user_favorite_food');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('leaves an English key alone', async () => {
    const d = deps();
    const r = await runRememberFact({ ...base, about: 'other', fact_key: 'colleague_marko_coffee', fact_value: 'mag keinen Kaffee' }, d);
    expect(r.fact_key).toBe('colleague_marko_coffee');
  });
});
