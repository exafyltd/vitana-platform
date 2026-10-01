/**
 * VTID-04766: the people in a member's life.
 *
 * Production session live-755a02b7 (2026-09-29): "ihr Vater heißt Viktor und
 * die Mutter heißt Tatjana" (the wife's parents) was stored once as
 * maria_maksina_father / maria_maksina_mother and once as father_name /
 * mother_name — the member's own parents — which his own parents then
 * replaced. "wie heißt der Vater meiner Ehefrau" went unanswered.
 */
import {
  parseRelationKey,
  relationKey,
  sameRelative,
  formatPeopleBlock,
} from '../../../src/services/memory/people';
import {
  findRelatedFact,
  runRememberFact,
  createPendingConflictStore,
} from '../../../src/services/memory/remember-fact-tool';
import { formatContextPackForLLM } from '../../../src/services/context-pack-builder';
import * as fs from 'fs';
import * as path from 'path';

// The member's current facts after the 2026-09-30 correction.
const MEMBER = [
  { fact_key: 'spouse_name', fact_value: 'Maria Maksina' },
  { fact_key: 'spouse_birthday', fact_value: '4. November 1999' },
  { fact_key: 'maria_maksina_father', fact_value: 'Viktor' },
  { fact_key: 'maria_maksina_mother', fact_value: 'Tatjana' },
  { fact_key: 'father_name', fact_value: 'Marco' },
  { fact_key: 'mother_name', fact_value: 'Mirjana' },
  { fact_key: 'hunde_name', fact_value: 'Bello' },
  { fact_key: 'user_company', fact_value: 'Exafy' },
];

describe('VTID-04766 parseRelationKey', () => {
  it.each([
    ['spouse_name', ['spouse'], 'name'],
    ['wife_name', ['spouse'], 'name'],
    ['ehefrau_geburtstag', ['spouse'], 'birthday'],
    ['spouse_father_name', ['spouse', 'father'], 'name'],
    ['schwiegervater_name', ['spouse', 'father'], 'name'],
    ['father_in_law_name', ['spouse', 'father'], 'name'],
    ['father_name', ['father'], 'name'],
    ['mein_vater', ['father'], 'name'],
    ['user_pet_name', ['pet'], 'name'],
    ['hunde_name', ['dog'], 'name'],
    ['child_spouse_name', ['child', 'spouse'], 'name'],
    ['colleague_marko_coffee', ['colleague'], 'marko_coffee'],
  ])('%s', (key, p, attr) => expect(parseRelationKey(key)).toEqual({ path: p, attribute: attr }));

  it('resolves a key that starts with a known relative\'s name', () => {
    expect(parseRelationKey('maria_maksina_father', MEMBER)).toEqual({ path: ['spouse', 'father'], attribute: 'name' });
    expect(parseRelationKey('maria_mother', MEMBER)).toEqual({ path: ['spouse', 'mother'], attribute: 'name' });
    expect(parseRelationKey('maria_maksina_birthday', MEMBER)).toEqual({ path: ['spouse'], attribute: 'birthday' });
  });

  it.each(['user_name', 'user_company', 'paul_birthday', 'kind_of_music', 'gro_vater', 'favorite_food'])(
    '%s names no relative',
    (key) => expect(parseRelationKey(key, MEMBER)).toBeNull(),
  );
});

describe('VTID-04766 relationKey / sameRelative', () => {
  it('gives every spelling of a relative one key', () => {
    expect(relationKey('maria_maksina_father', MEMBER)).toBe('spouse_father_name');
    expect(relationKey('schwiegervater_name')).toBe('spouse_father_name');
    expect(relationKey('wife_name')).toBe('spouse_name');
    expect(relationKey('user_name')).toBeNull();
    // Already said the canonical way: the extractor's own keys stay as they are.
    expect(relationKey('user_pet_name')).toBeNull();
    expect(relationKey('spouse_father_name')).toBeNull();
  });

  it('never matches the wife\'s father to the member\'s own father', () => {
    expect(sameRelative('spouse_father_name', 'father_name')).toBe(false);
    expect(sameRelative('maria_maksina_mother', 'mother_name', MEMBER)).toBe(false);
    expect(sameRelative('spouse_father_name', 'maria_maksina_father', MEMBER)).toBe(true);
    expect(sameRelative('user_name', 'father_name')).toBeNull();
  });

  it('findRelatedFact pairs a relative only with the same relative', () => {
    const stored = MEMBER.map((f) => ({ ...f, extracted_at: 'x' }));
    expect(findRelatedFact('spouse_father_name', stored)?.fact_key).toBe('maria_maksina_father');
    expect(findRelatedFact('spouse_mother_name', stored)?.fact_key).toBe('maria_maksina_mother');
    // Before VTID-04766 this matched father_name (two shared words).
    const withoutWifeParents = stored.filter((f) => !f.fact_key.startsWith('maria_'));
    expect(findRelatedFact('spouse_father_name', withoutWifeParents)).toBeNull();
  });
});

function deps(stored: Array<{ fact_key: string; fact_value: string }>) {
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

const base = { tenant_id: 't', user_id: 'u' };

describe('VTID-04766 remember_fact with relatives', () => {
  it('saves the wife\'s father without touching the member\'s own father', async () => {
    const d = deps([
      { fact_key: 'spouse_name', fact_value: 'Maria Maksina' },
      { fact_key: 'father_name', fact_value: 'Marco' },
    ]);
    const r = await runRememberFact({ ...base, about: 'other', fact_key: 'maria_maksina_father', fact_value: 'Viktor' }, d);
    expect(r.status).toBe('saved');
    expect(r.fact_key).toBe('spouse_father_name');
    expect(d.write.mock.calls[0][0]).toEqual(expect.objectContaining({ fact_key: 'spouse_father_name', fact_value: 'Viktor' }));
  });

  it('knows a relative it already has under another spelling', async () => {
    const d = deps(MEMBER);
    const r = await runRememberFact({ ...base, about: 'other', fact_key: 'spouse_father_name', fact_value: 'Viktor' }, d);
    expect(r.status).toBe('already_known');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('asks about a different value for the same relative only', async () => {
    const d = deps(MEMBER);
    const r = await runRememberFact({ ...base, about: 'other', fact_key: 'schwiegervater_name', fact_value: 'Petar' }, d);
    expect(r.status).toBe('conflict');
    expect(r.stored_value).toBe('Viktor');
  });

  it('the member\'s own father is unaffected by the wife\'s father', async () => {
    const d = deps(MEMBER);
    const r = await runRememberFact({ ...base, about: 'self', fact_key: 'vater_name', fact_value: 'Marco' }, d);
    expect(r.status).toBe('already_known');
    expect(r.stored_value).toBe('Marco');
  });
});

describe('VTID-04766 people block', () => {
  it('lists who is who by relation to the member', () => {
    const block = formatPeopleBlock(MEMBER);
    expect(block).toContain('- spouse: name Maria Maksina; birthday 4. November 1999');
    expect(block).toContain('- spouse › father: name Viktor');
    expect(block).toContain('- spouse › mother: name Tatjana');
    expect(block).toContain('- father: name Marco');
    expect(block).toContain('- mother: name Mirjana');
    expect(block).toContain('- dog: name Bello');
    expect(block).not.toContain('Exafy');
    expect(block.indexOf('- father:')).toBeLessThan(block.indexOf('- spouse › father:'));
  });

  it('is empty when the member has no relatives stored', () => {
    expect(formatPeopleBlock([{ fact_key: 'user_company', fact_value: 'Exafy' }])).toBe('');
  });

  it('is part of the context the model gets', () => {
    const pack: any = {
      identity: { user_id: 'u', display_name: 'D', role: 'community' },
      session_state: { turn_number: 1, channel: 'orb' },
      memory_hits: MEMBER.map((f, i) => ({
        id: String(i), category_key: 'fact:self', content: `${f.fact_key}: ${f.fact_value}`,
        importance: 90, occurred_at: 'x', source: 'memory_facts', relevance_score: 1,
      })),
      knowledge_hits: [],
      web_hits: [],
      active_vtids: [],
    };
    const text = formatContextPackForLLM(pack);
    expect(text).toContain('<people>');
    expect(text).toContain('- spouse › father: name Viktor');
  });

  it('the voice memory bridge renders the people block for memory_facts items', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/orb-memory-bridge.ts'), 'utf8');
    expect(src).toMatch(/formatPeopleBlock\(\s*structuredFacts\.map/);
  });
});

describe('VTID-04766 extractor rules', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/services/inline-fact-extractor.ts'), 'utf8');
  it('chains a relative of someone else from the member', () => {
    expect(src).toContain('the wife\'s father is spouse_father_name, never father_name');
  });
  it('stores nothing when "ihr Vater" does not say whose father', () => {
    expect(src).toMatch(/"ihr Vater".*return nothing for it/);
  });
});
